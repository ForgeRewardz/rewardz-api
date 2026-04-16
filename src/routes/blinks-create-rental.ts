/**
 * REWARDZ Blink — `create_rental` (plan task 42).
 *
 * Handles the three Solana Actions methods dial.to hits at request
 * time for the user-facing rental-creation Blink:
 *
 *   - GET  /v1/blinks/create-rental/:protocolId
 *     ActionGetResponse describing the action and the two
 *     user-input parameters: `duration` (the amount of stake units
 *     to rent — ties to the on-chain `amount` arg) and `maxFee`
 *     (the reward-rate-per-epoch ceiling the user is willing to
 *     offer — ties to the on-chain `rewardRatePerEpoch` arg).
 *
 *   - POST /v1/blinks/create-rental/:protocolId
 *     Assembles a VersionedTransaction for the `createRental`
 *     instruction and returns it base64-encoded in an
 *     ActionPostResponse.
 *
 *   - OPTIONS /v1/blinks/create-rental/:protocolId — preflight.
 *
 * Why this is a dedicated route and NOT a manifest-driven
 * `/v1/blinks/:protocolId/:instructionSlug` flow: the rental UX
 * needs curated parameter labels ("Duration" / "Max fee") that
 * don't match the raw IDL arg names, and the Blink URL is
 * published in places that reference the shorter,
 * instruction-specific path (/create-rental/:protocolId). The
 * manifest runtime in `blinks-runtime.ts` owns the generic
 * publish-any-IX pipeline; this file owns the one hand-curated
 * rental Blink that ships with the MVP.
 *
 * Chosen on-chain instruction: `createRental` (Codama
 * discriminator 11) from `@rewardz/sdk/generated` /
 * `ui/solana/client/instructions/createRental.ts`. That IX takes
 * `amount: u64` + `rewardRatePerEpoch: u64`; we surface them as
 * `duration` and `maxFee` respectively to match the user-facing
 * vocabulary from the spec (TODO-0018 plan row 42).
 *
 * Authentication: none. CORS headers are attached by the global
 * corsActionsPlugin `onRequest` hook (registered in server.ts)
 * plus a defensive re-apply inside each handler — same pattern
 * as blinks-runtime.ts.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ComputeBudgetProgram,
  Connection,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { applyActionsCorsHeaders } from "../middleware/cors-actions.js";
import { BASE58_PUBKEY } from "../types/solana.js";

/* -------------------------------------------------------------------------- */
/*  Compute-budget constants (mirrors blinks-runtime.ts)                      */
/* -------------------------------------------------------------------------- */

/** Compute unit limit applied to every rental-create tx. */
const BLINK_COMPUTE_UNIT_LIMIT = 200_000;

/** Priority fee (microlamports per compute unit). */
const BLINK_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1000;

/* -------------------------------------------------------------------------- */
/*  On-chain constants                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The rewardz-mvp program address. Kept hard-coded (matches the
 * value baked into the generated Codama client at
 * `sdk/packages/sdk/src/generated/programs/rewardzMvp.ts`) so the
 * route stays self-contained and does not reach into the generated
 * client — which would pull in `@solana/kit` types this file has
 * no use for.
 */
const REWARDZ_MVP_PROGRAM_ID = new PublicKey(
  "mineHEHyaVbQAkcPDDCuCSbkfGNid1RVz6GzcEgSVTh",
);

/**
 * Steel/Codama u8 discriminator for `createRental` (matches
 * `CREATE_RENTAL_DISCRIMINATOR = 11` in the generated client).
 */
const CREATE_RENTAL_DISCRIMINATOR = 11;

/** UTF-8 seed prefix for the `UserStake` PDA (["user_stake", authority]). */
const USER_STAKE_SEED = Buffer.from("user_stake", "utf8");

/**
 * UTF-8 seed prefix for the `RentalAgreement` PDA
 * (["rental", userAuthority, protocolAuthority]).
 */
const RENTAL_SEED = Buffer.from("rental", "utf8");

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface CreateRentalParams {
  protocolId: string;
}

interface CreateRentalQuery {
  /** u64 as decimal string — rental `amount` on-chain. */
  duration?: string;
  /** u64 as decimal string — rental `rewardRatePerEpoch` on-chain. */
  maxFee?: string;
}

interface CreateRentalPostBody {
  account: string;
  data?: {
    duration?: string;
    maxFee?: string;
  };
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

interface ActionPostResponse {
  transaction: string;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Send a JSON error payload with the CORS headers attached. Global
 * hook sets them too; we re-apply defensively (same rationale as
 * blinks-runtime.ts:sendActionError).
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
 * Fetch a protocol's on-chain authority (admin_wallet) and its
 * human-facing name. Returns null if the row is missing so the
 * caller can emit a 404 without leaking a DB error to dial.to.
 */
async function loadProtocolAuthority(
  protocolId: string,
): Promise<{ authority: string; name: string } | null> {
  // UUID-shaped guard: rejects obviously bogus path params before
  // the query. We accept any non-empty string that matches UUID
  // format; Postgres will return zero rows for anything else so
  // the extra filter here is cheap insurance.
  if (!protocolId || typeof protocolId !== "string" || protocolId.length > 64) {
    return null;
  }

  const result = await query<{ admin_wallet: string; name: string }>(
    "SELECT admin_wallet, name FROM protocols WHERE id = $1 LIMIT 1",
    [protocolId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { authority: row.admin_wallet, name: row.name };
}

/**
 * Resolve the reward-token mint used for rental payouts.
 *
 * Read from `REWARD_TOKEN_MINT` at call time (NOT module-load time)
 * so the route still registers cleanly on a server that has not
 * yet wired the env var — the handler 503s instead of crashing
 * the whole API boot. Tests set the env before calling
 * `app.inject`.
 */
function resolveRewardTokenMint(): PublicKey | null {
  const raw = process.env.REWARD_TOKEN_MINT;
  if (!raw || !BASE58_PUBKEY.test(raw)) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a u64-ish string to bigint. Returns null when the value
 * is not a base-10 non-negative integer or exceeds 2^64-1.
 */
function parseU64(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/^\d+$/.test(value)) return null;
  let bi: bigint;
  try {
    bi = BigInt(value);
  } catch {
    return null;
  }
  if (bi < 0n) return null;
  if (bi > 0xffff_ffff_ffff_ffffn) return null;
  return bi;
}

/**
 * Encode `createRental` ix data: [u8 discriminator][u64 amount LE]
 * [u64 rewardRatePerEpoch LE]. Fixed 17-byte wire shape matches
 * `getCreateRentalInstructionDataEncoder` in the generated client.
 */
function encodeCreateRentalData(
  amount: bigint,
  rewardRatePerEpoch: bigint,
): Buffer {
  const buf = Buffer.alloc(1 + 8 + 8);
  buf.writeUInt8(CREATE_RENTAL_DISCRIMINATOR, 0);
  buf.writeBigUInt64LE(amount, 1);
  buf.writeBigUInt64LE(rewardRatePerEpoch, 9);
  return buf;
}

/**
 * Derive the `UserStake` PDA for an authority. Seeds mirror
 * `findUserStakePda` in the generated client.
 */
function deriveUserStakePda(authority: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [USER_STAKE_SEED, authority.toBuffer()],
    REWARDZ_MVP_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the `RentalAgreement` PDA. Seeds mirror
 * `findRentalAgreementPda` in the generated client.
 */
function deriveRentalPda(
  userAuthority: PublicKey,
  protocolAuthority: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [RENTAL_SEED, userAuthority.toBuffer(), protocolAuthority.toBuffer()],
    REWARDZ_MVP_PROGRAM_ID,
  );
  return pda;
}

/**
 * Build the raw `createRental` TransactionInstruction. Account
 * order + writable/signer flags must match the generated client
 * exactly — keep them aligned with
 * `sdk/packages/sdk/src/generated/instructions/createRental.ts`.
 */
function buildCreateRentalIx(args: {
  user: PublicKey;
  userStake: PublicKey;
  rental: PublicKey;
  rewardTokenMint: PublicKey;
  protocolAuthority: PublicKey;
  amount: bigint;
  rewardRatePerEpoch: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: REWARDZ_MVP_PROGRAM_ID,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: false },
      { pubkey: args.userStake, isSigner: false, isWritable: true },
      { pubkey: args.rental, isSigner: false, isWritable: true },
      { pubkey: args.rewardTokenMint, isSigner: false, isWritable: false },
      { pubkey: args.protocolAuthority, isSigner: false, isWritable: false },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: encodeCreateRentalData(args.amount, args.rewardRatePerEpoch),
  });
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function blinksCreateRentalRoutes(
  app: FastifyInstance,
): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /*  GET: ActionGetResponse                                                */
  /* ---------------------------------------------------------------------- */

  app.get<{ Params: CreateRentalParams }>(
    "/blinks/create-rental/:protocolId",
    async (request, reply) => {
      try {
        const protocol = await loadProtocolAuthority(request.params.protocolId);
        if (!protocol) {
          return sendActionError(reply, 404, "Protocol not found");
        }

        const parameters: ActionGetResponseParameter[] = [
          {
            name: "duration",
            label: "Duration (amount of stake to rent)",
            required: true,
          },
          {
            name: "maxFee",
            label: "Max fee (reward rate per epoch, lamports; optional)",
            required: false,
          },
        ];

        const basePath = `/v1/blinks/create-rental/${request.params.protocolId}`;
        const hrefQuery = parameters
          .map((p) => `${p.name}={${p.name}}`)
          .join("&");

        const response: ActionGetResponse = {
          // MVP placeholder — see blinks-runtime.ts for the same
          // fallback rationale (dial.to gracefully falls back to a
          // default icon when this 404s during dev).
          icon: "https://rewardz.fun/icon.png",
          label: "Rent stake",
          title: `Rent stake from ${protocol.name}`,
          description: `Create a rental agreement with ${protocol.name}. You specify the rental duration (amount) and the max reward rate per epoch you're willing to accept; the protocol pays yield into your rental until it is settled.`,
          links: {
            actions: [
              {
                label: "Create rental",
                href: `${basePath}?${hrefQuery}`,
                parameters,
              },
            ],
          },
        };

        applyActionsCorsHeaders(reply);
        return reply.status(200).send(response);
      } catch (err) {
        request.log.error(err, "blinks-create-rental GET failed");
        return sendActionError(reply, 500, "Failed to load rental blink");
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /*  POST: VersionedTransaction assembly                                   */
  /* ---------------------------------------------------------------------- */

  app.post<{
    Params: CreateRentalParams;
    Body: CreateRentalPostBody;
    Querystring: CreateRentalQuery;
  }>("/blinks/create-rental/:protocolId", async (request, reply) => {
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
      if (!BASE58_PUBKEY.test(body.account)) {
        return sendActionError(
          reply,
          400,
          "ActionPostRequest.account is not a valid base58 pubkey",
        );
      }

      // Parameters may arrive on the body.data object (standard
      // ActionPostRequest) OR on the querystring (dial.to substitutes
      // `{name}` placeholders into the URL). Accept both and prefer
      // the body when present to match dial.to's precedence rules.
      const durationRaw =
        body.data?.duration ?? request.query.duration ?? undefined;
      const maxFeeRaw = body.data?.maxFee ?? request.query.maxFee ?? undefined;

      const amount = parseU64(durationRaw);
      if (amount === null) {
        return sendActionError(
          reply,
          400,
          "`duration` must be a base-10 u64 string",
        );
      }
      // `maxFee` is optional per the Blink spec — when absent, default to 0
      // (user accepts the protocol's posted reward rate). Only validate shape
      // when the field is supplied.
      let rewardRatePerEpoch: bigint;
      if (maxFeeRaw === undefined || maxFeeRaw === "") {
        rewardRatePerEpoch = 0n;
      } else {
        const parsed = parseU64(maxFeeRaw);
        if (parsed === null) {
          return sendActionError(
            reply,
            400,
            "`maxFee` must be a base-10 u64 string when provided",
          );
        }
        rewardRatePerEpoch = parsed;
      }

      const protocol = await loadProtocolAuthority(request.params.protocolId);
      if (!protocol) {
        return sendActionError(reply, 404, "Protocol not found");
      }
      if (!BASE58_PUBKEY.test(protocol.authority)) {
        // Defensive: the admin_wallet column is free-form text, so a
        // corrupted row shouldn't panic the tx builder.
        return sendActionError(
          reply,
          500,
          "Protocol on-chain authority is malformed",
        );
      }

      const rewardTokenMint = resolveRewardTokenMint();
      if (!rewardTokenMint) {
        return sendActionError(
          reply,
          503,
          "REWARD_TOKEN_MINT env var is not configured",
        );
      }

      const userPubkey = new PublicKey(body.account);
      const protocolAuthority = new PublicKey(protocol.authority);
      const userStake = deriveUserStakePda(userPubkey);
      const rental = deriveRentalPda(userPubkey, protocolAuthority);

      // Assemble the final ix list — same shape as the runtime POST:
      //   [computeLimit, computePrice, createRentalIx]
      // No ATA prelude: createRental doesn't touch token accounts
      // (the reward mint is readonly and only used for invariants).
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: BLINK_COMPUTE_UNIT_LIMIT,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: BLINK_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
        }),
        buildCreateRentalIx({
          user: userPubkey,
          userStake,
          rental,
          rewardTokenMint,
          protocolAuthority,
          amount,
          rewardRatePerEpoch,
        }),
      ];

      const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
      const { blockhash } = await connection.getLatestBlockhash({
        commitment: "confirmed",
      });

      const message = MessageV0.compile({
        payerKey: userPubkey,
        recentBlockhash: blockhash,
        instructions: ixs,
      });

      const tx = new VersionedTransaction(message);
      const serialised = Buffer.from(tx.serialize()).toString("base64");

      const response: ActionPostResponse = {
        transaction: serialised,
        message: `Create rental with ${protocol.name} prepared`,
      };

      applyActionsCorsHeaders(reply);
      return reply.status(200).send(response);
    } catch (err) {
      request.log.error(err, "blinks-create-rental POST failed");
      return sendActionError(reply, 500, "Failed to build transaction");
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  OPTIONS: preflight                                                    */
  /* ---------------------------------------------------------------------- */

  app.options<{ Params: CreateRentalParams }>(
    "/blinks/create-rental/:protocolId",
    async (_request, reply) => {
      // The cors-actions onRequest hook already attaches the headers
      // and short-circuits with 204 (same as blinks-runtime.ts); this
      // handler is a defensive fallback for routing edge cases.
      applyActionsCorsHeaders(reply);
      return reply.status(204).send();
    },
  );
}

export default blinksCreateRentalRoutes;
