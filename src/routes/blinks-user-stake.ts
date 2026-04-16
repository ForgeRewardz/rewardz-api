/**
 * Dedicated Solana Actions handler for the REWARDZ `user_stake` blink.
 *
 * Provides a stable, human-readable URL for dial.to to stake REWARDZ
 * tokens into a protocol's stake pool:
 *
 *   - GET  /v1/blinks/user-stake/:protocolId
 *     Returns an ActionGetResponse with a single `amount` parameter so
 *     dial.to can render the stake form.
 *
 *   - POST /v1/blinks/user-stake/:protocolId
 *     Accepts `{ account: string, data?: { amount: string } }` (or
 *     `?amount=` as a querystring fallback — dial.to substitutes the
 *     placeholder in the href template before POSTing). Resolves the
 *     protocol's published `user-stake` blink manifest, delegates to
 *     the SDK `buildInstruction` for discriminator + arg packing, then
 *     composes a VersionedTransaction with the compute-budget prelude
 *     and the user's stake ATA create-idempotent prelude.
 *
 *   - OPTIONS /v1/blinks/user-stake/:protocolId
 *     Preflight. The `cors-actions` onRequest hook already handles
 *     this globally; the explicit route is a defensive fallback for
 *     environments where the hook is bypassed.
 *
 * This handler is a CONSUMER of a manifest published via
 * `blinks-publish.ts` — it does not publish anything. The protocol
 * admin must first publish the `userStake` instruction through the
 * console wizard; this route then surfaces that published blink at a
 * friendlier URL than the generic
 * `/v1/blinks/:protocolId/:instructionSlug/:fixedAccountsHash?` runtime
 * path. The `user-stake` instruction slug and the reward mint →
 * `userToken` ATA convention are baked in here.
 *
 * Authentication: none. dial.to cannot forward cookies or JWTs, so the
 * route is public and the CORS headers come from `corsActionsPlugin`.
 *
 * Authoritative spec: TODO-0018 task 41 "blinks: user_stake".
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
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Kebab-case slug published by `blinks-service.publishBlink` for the
 * `userStake` IDL instruction. Pinned here as a literal so the route
 * can look the manifest up without running the SDK's `toKebabCase`
 * helper — keeps the public URL stable even if the SDK changes its
 * slug algorithm.
 */
const USER_STAKE_INSTRUCTION_SLUG = "user-stake";

/**
 * Compute unit limit mirroring `blinks-runtime.ts`. 200k units covers
 * the ATA idempotent prelude + the stake transfer + the PDA write
 * with comfortable headroom for future program upgrades. Kept as a
 * module-private constant rather than a shared import because the
 * number is a route-layer tuning knob and sharing it across handlers
 * would make future per-route adjustments harder.
 */
const BLINK_COMPUTE_UNIT_LIMIT = 200_000;

/**
 * Priority fee per compute unit. 1000 microlamports matches
 * `blinks-runtime.ts` and is low enough to avoid overpaying on
 * devnet while still landing ahead of fee-less traffic.
 */
const BLINK_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1000;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface UserStakeRouteParams {
  protocolId: string;
}

interface ActionGetResponseParameter {
  name: string;
  label: string;
  type?: "text" | "email" | "url" | "number" | "date" | "datetime-local";
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

/**
 * POST body shape. `data.amount` matches the task spec; we also
 * accept `?amount=` in the querystring because dial.to substitutes
 * the `{amount}` placeholder in the GET response's href template
 * before POSTing, and it's safer to honour both conventions than to
 * argue with a rendering client at runtime.
 */
interface ActionPostRequest {
  account: string;
  data?: {
    amount?: string;
  };
}

interface ActionPostResponse {
  transaction: string;
  message?: string;
}

interface ActionErrorResponse {
  error: {
    message: string;
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Send an ActionErrorResponse-shaped JSON payload with the actions
 * CORS headers re-applied. Fastify's reply lifecycle can drop headers
 * set only by the onRequest hook on some error paths, so we set them
 * again here defensively (same discipline as `blinks-runtime.ts`).
 */
function sendActionError(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  applyActionsCorsHeaders(reply);
  const body: ActionErrorResponse = { error: { message } };
  return reply.status(status).send(body);
}

/**
 * Load the published `user-stake` manifest for a protocol. Returns
 * `null` when no matching row exists so the caller can emit a 404
 * instead of an opaque 500. Re-throws multi-live-pin errors so the
 * caller can surface them as 409s.
 */
async function loadUserStakeManifest(
  protocolId: string,
): Promise<BlinkManifest | null> {
  return getBlink(protocolId, USER_STAKE_INSTRUCTION_SLUG);
}

/**
 * Build the ATA prelude for every `user-ata` account declared in the
 * manifest's classification. Mirrors the logic in
 * `blinks-runtime.buildAtaPrelude` — kept inline (rather than
 * factored into a shared helper) because the runtime file owns the
 * generic path and this route only ever ships `user-stake` manifests
 * with a single `userToken` ATA; sharing the helper would couple
 * otherwise-independent code paths.
 */
function buildUserStakeAtaPrelude(
  manifest: BlinkManifest,
  payer: PublicKey,
): TransactionInstruction[] {
  const prelude: TransactionInstruction[] = [];

  for (const [accountName, bucket] of Object.entries(
    manifest.classification.accounts,
  )) {
    if (bucket !== "user-ata") continue;

    // Resolve the mint for the ATA. For the REWARDZ user-stake flow
    // the ATA is `userToken` whose mint is the reward mint — either
    // declared as `userTokenMint` (explicit) or `rewardMint` (the
    // REWARDZ-side convention). Falling back silently to the
    // conventional `rewardMint` key matches the runtime handler so
    // admins don't have to duplicate the mint under two names.
    const mintKey =
      manifest.fixedAccounts[`${accountName}Mint`] ??
      manifest.fixedAccounts.rewardMint;
    if (!mintKey) continue;

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
 * Coerce the `amount` input into a base-10 string. Accepts any value
 * dial.to might send (string, number, array when a key is repeated)
 * and normalises to the single string the SDK `buildInstruction`
 * expects. Returns null when the input is missing or empty so the
 * caller can emit a 400.
 */
function coerceAmountInput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined || first === null) return null;
    const coerced = String(first).trim();
    return coerced.length === 0 ? null : coerced;
  }
  const coerced = String(value).trim();
  return coerced.length === 0 ? null : coerced;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function blinksUserStakeRoutes(
  app: FastifyInstance,
): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /*  GET: ActionGetResponse                                                */
  /* ---------------------------------------------------------------------- */

  app.get<{ Params: UserStakeRouteParams }>(
    "/blinks/user-stake/:protocolId",
    async (request, reply) => {
      try {
        const manifest = await loadUserStakeManifest(request.params.protocolId);
        if (!manifest) {
          return sendActionError(
            reply,
            404,
            "User stake blink not found for this protocol",
          );
        }

        // Single required numeric parameter. The `{amount}` placeholder
        // in the href is substituted by dial.to with the user's input
        // before POSTing back — the POST handler falls back to reading
        // it from the body when a client skips the querystring.
        const parameters: ActionGetResponseParameter[] = [
          {
            name: "amount",
            label: "Stake amount",
            type: "number",
            required: true,
          },
        ];

        const href = `/v1/blinks/user-stake/${request.params.protocolId}?amount={amount}`;

        const response: ActionGetResponse = {
          // Placeholder icon — the console wizard will eventually
          // publish a protocol logo alongside the manifest. For now
          // dial.to falls back to its default if this 404s.
          icon: "https://rewardz.fun/icon.png",
          label: "Stake REWARDZ",
          title: "Stake REWARDZ",
          description:
            "Stake REWARDZ tokens into this protocol's stake pool to earn rewards.",
          links: {
            actions: [
              {
                label: "Stake",
                href,
                parameters,
              },
            ],
          },
        };

        applyActionsCorsHeaders(reply);
        return reply.status(200).send(response);
      } catch (err) {
        request.log.error(err, "blinks-user-stake GET failed");
        const message = err instanceof Error ? err.message : String(err);
        if (/multiple live/i.test(message)) {
          return sendActionError(reply, 409, message);
        }
        return sendActionError(reply, 500, "Failed to load user stake blink");
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /*  POST: VersionedTransaction assembly                                   */
  /* ---------------------------------------------------------------------- */

  app.post<{
    Params: UserStakeRouteParams;
    Body: ActionPostRequest;
    Querystring: Record<string, string>;
  }>("/blinks/user-stake/:protocolId", async (request, reply) => {
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

      // Amount can arrive either in the POST body (per the task spec's
      // `{ account, data: { amount } }` shape) or in the querystring
      // (per dial.to's href-template substitution convention). Prefer
      // body.data.amount when both are present so an explicit body
      // beats a potentially stale querystring.
      const query = request.query as Record<string, unknown>;
      const amount =
        coerceAmountInput(body.data?.amount) ?? coerceAmountInput(query.amount);
      if (!amount) {
        return sendActionError(
          reply,
          400,
          "amount is required (send as body.data.amount or ?amount=)",
        );
      }

      const manifest = await loadUserStakeManifest(request.params.protocolId);
      if (!manifest) {
        return sendActionError(
          reply,
          404,
          "User stake blink not found for this protocol",
        );
      }

      // Delegate discriminator + arg packing to the SDK. Any shape
      // error (malformed amount, unresolvable PDA seed) surfaces as a
      // 400 so the caller sees a deterministic message rather than a
      // generic 500 from a downstream web3.js decoder.
      let built;
      try {
        built = buildInstruction({
          manifest,
          params: { amount },
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

      // Compose the final ix list:
      //   [computeLimit, computePrice, ...ataPrelude, targetIx]
      // Order matters — compute-budget must be first so the runtime
      // honours the limit for the whole tx, and the ATA prelude must
      // land before the target ix that references the ATA.
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
      ixs.push(...buildUserStakeAtaPrelude(manifest, payerPubkey));

      // Convert the SDK's RPC-agnostic BuiltInstruction shape into a
      // web3.js TransactionInstruction. The string → PublicKey hop is
      // the only point where we leave the "just bytes" world.
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

      // Fetch a fresh blockhash and compile to MessageV0. Tests
      // monkey-patch `Connection.prototype.getLatestBlockhash` to
      // return a deterministic blockhash (see blinks.e2e.test.ts).
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
        message: "Stake REWARDZ prepared",
      };

      applyActionsCorsHeaders(reply);
      return reply.status(200).send(response);
    } catch (err) {
      request.log.error(err, "blinks-user-stake POST failed");
      const message = err instanceof Error ? err.message : String(err);
      if (/multiple live/i.test(message)) {
        return sendActionError(reply, 409, message);
      }
      return sendActionError(
        reply,
        500,
        "Failed to build user stake transaction",
      );
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  OPTIONS: preflight fallback                                           */
  /* ---------------------------------------------------------------------- */

  app.options<{ Params: UserStakeRouteParams }>(
    "/blinks/user-stake/:protocolId",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // The cors-actions onRequest hook already returns 204 with the
      // header set for OPTIONS on /v1/blinks/*. This explicit route
      // is a defensive fallback for callers that bypass the hook
      // (e.g. some proxy configurations that strip OPTIONS before it
      // reaches Fastify's onRequest phase).
      applyActionsCorsHeaders(reply);
      return reply.status(204).send();
    },
  );
}

export default blinksUserStakeRoutes;
