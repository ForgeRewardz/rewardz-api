/**
 * Public runtime routes for published blinks.
 *
 * This module owns the three HTTP methods that dial.to (and any other
 * Solana Actions client) hits at request time:
 *
 *   - GET  /v1/blinks/:protocolId/:instructionSlug/:fixedAccountsHash?
 *     Returns an ActionGetResponse — the manifest-driven label, title,
 *     description, and the parameters[] array synthesised from the
 *     user-input args in the stored manifest.
 *
 *   - POST /v1/blinks/:protocolId/:instructionSlug/:fixedAccountsHash?
 *     Added in 75b — assembles a VersionedTransaction.
 *
 *   - OPTIONS /v1/blinks/... — preflight handler added in 75c.
 *
 * None of these routes require authentication. The CORS headers come
 * from the corsActionsPlugin onRequest hook registered globally.
 *
 * Authoritative spec: TODO-0015 §15G "API note — what api/ must add".
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ComputeBudgetProgram,
  Connection,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { BlinkManifest } from "@rewardz/sdk/blinks";
import { buildInstruction } from "@rewardz/sdk/blinks";
import { config } from "../config.js";
import { getBlink } from "../services/blinks-service.js";
import { applyActionsCorsHeaders } from "../middleware/cors-actions.js";

/* -------------------------------------------------------------------------- */
/*  Compute-budget constants                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compute unit limit applied to every blink tx. 200k units is enough
 * for a stake / mint / completion ix plus the ATA prelude. Bumping
 * this higher costs microlamports at tx time without giving honest
 * users any benefit.
 */
const BLINK_COMPUTE_UNIT_LIMIT = 200_000;

/**
 * Priority fee in microlamports per compute unit. 1000 is low enough
 * to avoid overpaying on devnet / testnet while still getting the tx
 * priority above no-fee traffic during landing.
 */
const BLINK_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1000;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface BlinkRouteParams {
  protocolId: string;
  instructionSlug: string;
  fixedAccountsHash?: string;
}

interface ActionGetResponseParameter {
  name: string;
  label: string;
  required: boolean;
}

interface ActionGetResponseLink {
  label: string;
  href: string;
  parameters?: ActionGetResponseParameter[];
}

interface ActionGetResponse {
  icon: string;
  label: string;
  title: string;
  description: string;
  links?: {
    actions: ActionGetResponseLink[];
  };
}

interface ActionPostRequest {
  account: string;
}

interface ActionPostResponse {
  transaction: string;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a human-readable title from an IDL instruction name. The
 * stored manifest.instructionName is camelCase (from the IDL); this
 * helper splits on case boundaries and title-cases the words.
 */
function humaniseInstructionName(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Render the `parameters[]` array for an ActionGetResponse from the
 * manifest's argLayout. Every arg that the classification marks as
 * `user-input` becomes a required parameter. Arg labels reuse the
 * humanised arg name.
 */
function parametersFromManifest(
  manifest: BlinkManifest,
): ActionGetResponseParameter[] {
  const params: ActionGetResponseParameter[] = [];
  for (const arg of manifest.argLayout) {
    const bucket = manifest.classification.args[arg.name];
    if (bucket === "user-input") {
      params.push({
        name: arg.name,
        label: humaniseInstructionName(arg.name),
        required: true,
      });
    }
  }
  return params;
}

/**
 * Build a query-parameter suffix for the Action href from the
 * parameter list. dial.to substitutes `{name}` placeholders with
 * user input before POSTing, so the href must include them
 * verbatim.
 */
function buildHrefQueryTemplate(
  params: ActionGetResponseParameter[],
): string {
  if (params.length === 0) return "";
  const pairs = params.map((p) => `${p.name}={${p.name}}`);
  return `?${pairs.join("&")}`;
}

/**
 * Send a JSON error payload with the CORS headers attached. The
 * global onRequest hook sets these too, but we re-apply defensively
 * because the hook runs before the body is serialised and a late
 * header mutation can sometimes be dropped by Fastify's reply lifecycle.
 */
function sendActionError(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  applyActionsCorsHeaders(reply);
  return reply.status(status).send({ error: message });
}

/**
 * Build the ATA prelude for every `user-ata` account in the
 * classification. For each ATA:
 *
 *   1. Resolve the mint pubkey. For MVP we look up
 *      `fixedAccounts[accountName + "Mint"]` — e.g. the user-ata
 *      account `userToken` pairs with `userTokenMint` or `rewardMint`
 *      (when the instruction already declares the mint as a fixed
 *      account). Falls back to `fixedAccounts.rewardMint` if set.
 *
 *   2. Choose the token program flavour from `manifest.mintOwners`.
 *      Defaults to legacy SPL.
 *
 *   3. Emit `createAssociatedTokenAccountIdempotentInstruction`.
 *
 * The ATA is idempotent so honest users who already have the account
 * pay a single byte of rent and nothing else.
 */
function buildAtaPrelude(
  manifest: BlinkManifest,
  payer: PublicKey,
): TransactionInstruction[] {
  const prelude: TransactionInstruction[] = [];

  for (const [accountName, bucket] of Object.entries(
    manifest.classification.accounts,
  )) {
    if (bucket !== "user-ata") continue;

    // Conventional mint lookup: accountName + "Mint" OR
    // "rewardMint" (the most common rewardz-side case). Callers that
    // need a different convention must upgrade the blink manifest
    // publish pipeline to carry an explicit ata→mint map.
    const mintKey =
      manifest.fixedAccounts[`${accountName}Mint`] ??
      manifest.fixedAccounts.rewardMint;
    if (!mintKey) {
      // No mint → cannot prelude; buildInstruction will still fail
      // later so the caller sees a meaningful error rather than a
      // silent wrong-ata tx.
      continue;
    }

    const mint = new PublicKey(mintKey);
    const programFlavour = manifest.mintOwners[accountName] ?? "legacy";
    const tokenProgramId =
      programFlavour === "token-2022"
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

    const ata = getAssociatedTokenAddressSync(
      mint,
      payer,
      true,
      tokenProgramId,
    );
    prelude.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        ata,
        payer,
        mint,
        tokenProgramId,
      ),
    );
  }

  return prelude;
}

/**
 * Load the manifest for a runtime request, handling the two
 * "missing hash" disambiguation cases with structured errors.
 *
 * Returns null on true 404, throws on 409 (multiple live pins), and
 * returns the manifest on success.
 */
async function loadManifestOr404(
  params: BlinkRouteParams,
): Promise<BlinkManifest | null> {
  return getBlink(
    params.protocolId,
    params.instructionSlug,
    params.fixedAccountsHash,
  );
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function blinksRuntimeRoutes(
  app: FastifyInstance,
): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /*  GET (75a): ActionGetResponse                                          */
  /* ---------------------------------------------------------------------- */

  const getHandler = async (
    request: FastifyRequest<{ Params: BlinkRouteParams }>,
    reply: FastifyReply,
  ) => {
    try {
      const manifest = await loadManifestOr404(request.params);
      if (!manifest) {
        return sendActionError(reply, 404, "Blink not found");
      }

      const params = parametersFromManifest(manifest);
      const basePath = request.params.fixedAccountsHash
        ? `/v1/blinks/${request.params.protocolId}/${request.params.instructionSlug}/${request.params.fixedAccountsHash}`
        : `/v1/blinks/${request.params.protocolId}/${request.params.instructionSlug}`;

      const humanName = humaniseInstructionName(manifest.instructionName);

      const response: ActionGetResponse = {
        // MVP placeholder: the console wizard will publish a protocol
        // logo URL alongside the manifest in a future session. For
        // now dial.to falls back to a default icon when this path is
        // a 404.
        icon: "https://rewardz.fun/icon.png",
        label: humanName,
        title: `${humanName} with REWARDZ`,
        description: `Execute the ${manifest.instructionName} instruction on program ${manifest.programId}.`,
        links: {
          actions: [
            {
              label: "Submit",
              href: `${basePath}${buildHrefQueryTemplate(params)}`,
              parameters: params,
            },
          ],
        },
      };

      applyActionsCorsHeaders(reply);
      return reply.status(200).send(response);
    } catch (err) {
      request.log.error(err, "blinks-runtime GET failed");
      const message = err instanceof Error ? err.message : String(err);
      if (/multiple live/i.test(message)) {
        return sendActionError(reply, 409, message);
      }
      return sendActionError(reply, 500, "Failed to load blink");
    }
  };

  app.get<{ Params: BlinkRouteParams }>(
    "/blinks/:protocolId/:instructionSlug/:fixedAccountsHash",
    getHandler,
  );
  app.get<{ Params: BlinkRouteParams }>(
    "/blinks/:protocolId/:instructionSlug",
    getHandler,
  );

  /* ---------------------------------------------------------------------- */
  /*  POST (75b): VersionedTransaction assembly                             */
  /* ---------------------------------------------------------------------- */

  const postHandler = async (
    request: FastifyRequest<{
      Params: BlinkRouteParams;
      Body: ActionPostRequest;
      Querystring: Record<string, string>;
    }>,
    reply: FastifyReply,
  ) => {
    try {
      const body = request.body;
      if (
        !body ||
        typeof body.account !== "string" ||
        body.account.length === 0
      ) {
        return sendActionError(
          reply,
          400,
          "ActionPostRequest.account is required",
        );
      }

      const manifest = await loadManifestOr404(request.params);
      if (!manifest) {
        return sendActionError(reply, 404, "Blink not found");
      }

      // Coerce the query values into strings. Fastify typically
      // does this already but a Record<string, string[]> can slip
      // through when the client repeats a key — take the first.
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        request.query as Record<string, unknown>,
      )) {
        if (Array.isArray(v)) {
          params[k] = String(v[0] ?? "");
        } else if (v !== undefined && v !== null) {
          params[k] = String(v);
        }
      }

      // Build the target ix via the SDK. This is the single place
      // that owns discriminator + arg packing; bugs here ship wrong
      // txs that fail on-chain, so the code path is deliberately
      // boring and RPC-agnostic.
      let built;
      try {
        built = buildInstruction({
          manifest,
          params,
          payer: body.account,
        });
      } catch (err) {
        return sendActionError(
          reply,
          400,
          `Instruction build failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const payerPubkey = new PublicKey(body.account);

      // Assemble the final ix list:
      //   [computeLimit, computePrice, ...ataPrelude, targetIx]
      const ixs: TransactionInstruction[] = [];
      ixs.push(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: BLINK_COMPUTE_UNIT_LIMIT,
        }),
      );
      ixs.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: BLINK_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
        }),
      );
      ixs.push(...buildAtaPrelude(manifest, payerPubkey));

      // The SDK returns keys as { pubkey: string, isSigner, isWritable }.
      // Convert to the @solana/web3.js TransactionInstruction shape.
      const targetIx = new TransactionInstruction({
        programId: new PublicKey(built.programId),
        keys: built.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from(built.data),
      });
      ixs.push(targetIx);

      // Fetch a fresh blockhash and compile to MessageV0. The RPC
      // lives in config.SOLANA_RPC_URL; tests that don't want live
      // RPC traffic should mock the Connection class.
      const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
      const { blockhash } = await connection.getLatestBlockhash({
        commitment: "confirmed",
      });

      const message = MessageV0.compile({
        payerKey: payerPubkey,
        recentBlockhash: blockhash,
        instructions: ixs,
      });

      const tx = new VersionedTransaction(message);
      const serialised = Buffer.from(tx.serialize()).toString("base64");

      const response: ActionPostResponse = {
        transaction: serialised,
        message: `${humaniseInstructionName(manifest.instructionName)} prepared`,
      };

      applyActionsCorsHeaders(reply);
      return reply.status(200).send(response);
    } catch (err) {
      request.log.error(err, "blinks-runtime POST failed");
      const message = err instanceof Error ? err.message : String(err);
      if (/multiple live/i.test(message)) {
        return sendActionError(reply, 409, message);
      }
      return sendActionError(reply, 500, "Failed to build transaction");
    }
  };

  app.post<{
    Params: BlinkRouteParams;
    Body: ActionPostRequest;
    Querystring: Record<string, string>;
  }>("/blinks/:protocolId/:instructionSlug/:fixedAccountsHash", postHandler);
  app.post<{
    Params: BlinkRouteParams;
    Body: ActionPostRequest;
    Querystring: Record<string, string>;
  }>("/blinks/:protocolId/:instructionSlug", postHandler);

  /* ---------------------------------------------------------------------- */
  /*  OPTIONS (75c): preflight                                              */
  /* ---------------------------------------------------------------------- */

  const optionsHandler = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // The cors-actions onRequest hook already attaches the headers
    // and short-circuits the reply with 204. If we somehow reach
    // this handler (because the hook didn't match or was bypassed
    // by a path typo), emit the headers + 204 ourselves as a
    // defensive fallback.
    applyActionsCorsHeaders(reply);
    return reply.status(204).send();
  };

  app.options<{ Params: BlinkRouteParams }>(
    "/blinks/:protocolId/:instructionSlug/:fixedAccountsHash",
    optionsHandler,
  );
  app.options<{ Params: BlinkRouteParams }>(
    "/blinks/:protocolId/:instructionSlug",
    optionsHandler,
  );
}

export default blinksRuntimeRoutes;
