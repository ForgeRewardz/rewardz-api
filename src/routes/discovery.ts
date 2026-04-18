import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { requireWalletAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  AT_RISK_DAMPENER,
  FEATURED_BOOST,
} from "../services/ranking-engine.js";
import { consumeQuota, readQuota } from "../services/discovery-quota.js";
import {
  type IntentResult,
  resolveIntent,
} from "../services/intent-resolver.js";
import { BASE58_PUBKEY } from "../types/solana.js";
import type { IntentAction, Protocol } from "../types/index.js";

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

// TODO-0018 §Mini-app: default discovery tiles = "top 2 community
// Blinks by quality_score" plus the mvp-smart-contracts native Blink.
// The native tile is injected client-side (it's not a DB protocol),
// so this endpoint only returns the community rows. Default limit of
// 6 gives mobile + mini-app room to render a small grid with a
// reasonable pool for deduping against recent impressions.
const DISCOVERY_DEFAULT_LIMIT = 6;
const DISCOVERY_MAX_LIMIT = 50;

const querySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit must be a positive integer")
    .transform((s) => Number(s))
    .refine(
      (n) => n >= 1 && n <= DISCOVERY_MAX_LIMIT,
      `limit must be 1..${DISCOVERY_MAX_LIMIT}`,
    )
    .optional(),
});

/* -------------------------------------------------------------------------- */
/*  /discovery/query validation + helpers                                     */
/* -------------------------------------------------------------------------- */

// Matches the wallet-header gate in requireWalletAuth (Solana base58 32..44).
// Declared locally so the zod parse of the body owns the shape check and the
// handler can reject obviously-malformed wallets before any DB work.
const WALLET_SCHEMA = z
  .string()
  .min(32)
  .max(44)
  .regex(BASE58_PUBKEY, "wallet must be a base58 Solana pubkey");

// NOTE: The authenticated wallet is sourced from `request.walletAddress`
// (populated by `requireWalletAuth`) — NOT from the body. Accepting a
// body-level `wallet` would let user A sign in then pass wallet B in the
// payload, consuming B's quota and having resolveIntent attribute the
// query to B. Dropping the field closes that bypass.
const discoveryQueryBodySchema = z.object({
  text: z.string().min(1).max(500),
});

const discoveryQuotaQuerySchema = z.object({
  wallet: WALLET_SCHEMA,
});

const SUGGESTIONS_DEFAULT = 2;
const SUGGESTIONS_MAX = 6;

const discoverySuggestionsQuerySchema = z.object({
  count: z
    .string()
    .regex(/^\d+$/, "count must be a positive integer")
    .transform((s) => Number(s))
    .refine(
      (n) => n >= 1 && n <= SUGGESTIONS_MAX,
      `count must be 1..${SUGGESTIONS_MAX}`,
    )
    .optional(),
  wallet: WALLET_SCHEMA.optional(),
});

/**
 * Deterministic seed of suggestion prompts covering the rules encoded in
 * intent-resolver.ts (marinade / jupiter / kamino + generic stake/swap).
 * Used by /discovery/suggestions and by /discovery/query when resolveIntent
 * returns zero matches — keeping a single source means the mini-app UX never
 * shows a "try one of these" list that contradicts the suggestions endpoint.
 */
const SUGGESTION_SEED: readonly string[] = [
  "stake 1 SOL on marinade",
  "swap 50 USDC to SOL on jupiter",
  "lend 100 USDC on kamino",
  "stake 5 SOL",
  "swap 25 USDC to SOL",
  "borrow 50 USDC on kamino",
] as const;

/**
 * Human-readable assistant reply for a resolved intent. Deterministic — no
 * LLM in the loop — so tests can assert on exact substrings and the
 * mini-app composer can render without a second round-trip.
 */
function formatAssistantText(result: IntentResult): string {
  const params = result.params as Record<string, unknown>;
  const amount =
    typeof params.amount === "number"
      ? String(params.amount)
      : typeof params.amount_in === "number"
        ? String(params.amount_in)
        : null;
  const asset =
    typeof params.asset === "string"
      ? params.asset
      : typeof params.asset_in === "string"
        ? params.asset_in
        : null;

  switch (result.action_type as IntentAction) {
    case "stake":
      return amount && asset
        ? `I can help you stake ${amount} ${asset}.`
        : asset
          ? `I can help you stake ${asset}.`
          : "I can help you stake.";
    case "swap": {
      const assetOut =
        typeof params.asset_out === "string" ? params.asset_out : null;
      if (amount && asset && assetOut) {
        return `I can help you swap ${amount} ${asset} to ${assetOut}.`;
      }
      if (asset && assetOut) {
        return `I can help you swap ${asset} to ${assetOut}.`;
      }
      return "I can help you swap tokens.";
    }
    case "lend":
      return amount && asset
        ? `I can help you lend ${amount} ${asset}.`
        : "I can help you lend.";
    case "borrow":
      return amount && asset
        ? `I can help you borrow ${amount} ${asset}.`
        : "I can help you borrow.";
    case "transfer":
      return amount
        ? `I can help you transfer ${amount}.`
        : "I can help you transfer.";
    case "mint":
      return "I can help you mint.";
    case "vote":
      return "I can help you vote.";
    case "tweet":
      return "I can help you post on X.";
    case "burn":
      return "I can help you burn tokens.";
    default:
      return "I'm not sure I can do that yet — here are some things you can try.";
  }
}

/**
 * Fetch the active-protocol registry. Duplicates the SELECT in
 * routes/intents.ts on purpose — modifying intents.ts is out of scope for
 * this task and the query is small enough that drift is easy to eyeball.
 */
async function fetchActiveProtocols(): Promise<Protocol[]> {
  const result = await query<Protocol>(
    `SELECT id, admin_wallet, name, description, blink_base_url, supported_actions,
            trust_score, status, created_at, updated_at
       FROM protocols
      WHERE status = 'active'`,
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /discovery/featured
   *
   * Default tiles for the mini-app home + mobile discovery surface.
   *
   * Ranking intent (per league-config.md §Visibility and plan tasks
   * 17/18):
   *   1. `hidden` protocols are excluded entirely.
   *   2. `at_risk` protocols are kept but dampened to 50% of
   *      quality_score — matches the ranking-engine's
   *      AT_RISK_DAMPENER so dashboards, /intents/resolve, and this
   *      surface all sink at_risk consistently.
   *   3. Protocols featured in the latest leaderboard snapshot get
   *      a small additive boost (+0.1) so yesterday's winners
   *      surface first even when a higher-quality_score protocol
   *      exists — reflects that "featured" is league-level
   *      recognition that we actively want to promote.
   *   4. Ties broken by creation order (deterministic).
   *
   * Response:
   *   200 {
   *     tiles: [{ protocolId, adminWallet, qualityScore, visibility,
   *               featured, rank, referralCode }]
   *   }
   *
   *   `rank` (number | null) is null when the protocol isn't present
   *   in today's leaderboard snapshot; the tile is still eligible if
   *   its quality_score pulls it into the top-N.
   */
  app.get(
    "/discovery/featured",
    { preHandler: [rateLimit(60_000, 120)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = querySchema.safeParse(request.query);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid query: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }
      const { limit = DISCOVERY_DEFAULT_LIMIT } = parse.data;

      try {
        // LEFT JOIN on the latest snapshot so a protocol that's
        // never been ranked still competes on quality_score alone.
        // The snapshot date sub-select takes MAX(snapshot_date)
        // which handles the "no snapshot yet" case by matching
        // nothing (LEFT JOIN preserves all rows).
        //
        // The score expression is computed in SQL so pagination
        // (future) remains DB-pushed rather than handler-side.
        const rows = await query<{
          protocol_id: string;
          admin_wallet: string;
          quality_score: string | null;
          visibility: "active" | "at_risk";
          featured: boolean;
          rank: number | null;
          referral_code: string | null;
        }>(
          `WITH latest_snapshot AS (
              SELECT MAX(snapshot_date) AS d FROM league_leaderboard_snapshots
          ),
          today_rows AS (
              SELECT s.protocol_id, s.rank, s.featured
                FROM league_leaderboard_snapshots s
                JOIN latest_snapshot l ON s.snapshot_date = l.d
          )
          SELECT p.id              AS protocol_id,
                 p.admin_wallet,
                 p.quality_score::text AS quality_score,
                 p.visibility,
                 COALESCE(t.featured, false) AS featured,
                 t.rank            AS rank,
                 p.referral_code
            FROM protocols p
            LEFT JOIN today_rows t ON t.protocol_id = p.id
           WHERE p.visibility <> 'hidden'
             AND p.status = 'active'
           ORDER BY (
               COALESCE(p.quality_score, 0)::float8
               * CASE WHEN p.visibility = 'at_risk' THEN $2::float8 ELSE 1.0 END
               + CASE WHEN COALESCE(t.featured, false) THEN $3::float8 ELSE 0.0 END
           ) DESC,
             p.created_at ASC
           LIMIT $1`,
          [limit, AT_RISK_DAMPENER, FEATURED_BOOST],
        );

        return reply.status(200).send({
          tiles: rows.rows.map((r) => ({
            protocolId: r.protocol_id,
            adminWallet: r.admin_wallet,
            qualityScore:
              r.quality_score == null ? null : Number(r.quality_score),
            visibility: r.visibility,
            featured: r.featured,
            rank: r.rank,
            referralCode: r.referral_code,
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to read discovery featured tiles");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to read discovery featured tiles",
        });
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /*  POST /discovery/query                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Chat-wrapper over POST /intents/resolve. The mini-app composer hits
   * this with the raw user text; the handler:
   *
   *   1. Validates the body (text + wallet).
   *   2. Consumes one unit of the per-wallet UTC-day free quota. When
   *      `consumed === false` we short-circuit to 402 Payment Required
   *      without invoking the resolver — this keeps Gemini costs bounded
   *      to the declared quota and matches the UX in §7.2 where the
   *      composer renders a "schedule for tomorrow" prompt.
   *   3. Runs resolveIntent against the active-protocol registry.
   *   4. Returns a chat-shaped envelope: assistantText + matches +
   *      quotaRemaining so the client can render without a second fetch.
   *
   * `fellBackToRules` is set when GEMINI_API_KEY is configured AND the
   * resolver still returned `rules` — i.e. the AI path failed or was
   * rate-limited and the rules matcher took over (per spec §7.4). When no
   * Gemini key is present the resolver always returns `rules` by design,
   * so reporting "fell back" there would be misleading.
   *
   * The rate-limit is lenient (60 req/min/ip) because the quota is the
   * real cost gate — rateLimit just blocks pathological loops.
   */
  app.post(
    "/discovery/query",
    { preHandler: [requireWalletAuth, rateLimit(60_000, 60)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = discoveryQueryBodySchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const { text } = parse.data;
      // Canonical wallet: the one that signed the auth challenge. Never
      // read wallet from the body here — see `discoveryQueryBodySchema`.
      const wallet = request.walletAddress!;

      try {
        // Check + consume quota in one round-trip. The service returns
        // `consumed: false` when today's counter is already at the limit;
        // we must not touch the resolver in that path.
        const quota = await consumeQuota(wallet);
        if (!quota.consumed) {
          return reply.status(402).send({
            error: "quota_exhausted",
            remaining: 0,
            resetAt: quota.resetAtUtc,
          });
        }

        const protocols = await fetchActiveProtocols();
        const result = await resolveIntent(text, wallet, protocols);

        const matches = result.offers.map((o) => ({
          protocolId: o.protocol_id,
          protocolName: o.protocol_name,
          actionType: o.action_type,
          points: o.points,
        }));

        const fellBackToRules =
          Boolean(config.GEMINI_API_KEY) && result.resolver_type === "rules";

        // Only surface suggestions when we couldn't find a matching
        // protocol — otherwise the composer shows both matches AND
        // prompts, which reads as "we succeeded but also gave up".
        const suggestions =
          matches.length === 0 ? SUGGESTION_SEED.slice(0, 3) : [];

        return reply.status(200).send({
          assistantText: formatAssistantText(result),
          intent: result.action_type,
          resolverType: result.resolver_type,
          confidence: result.confidence,
          matches,
          suggestions,
          fellBackToRules,
          quotaRemaining: quota.remaining,
        });
      } catch (err) {
        request.log.error(err, "Failed to handle /discovery/query");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to handle discovery query",
        });
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /*  GET /discovery/quota                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Read-only quota probe. Unauthenticated on purpose — the wallet is
   * already a public identifier and the numbers here don't leak anything
   * a user couldn't compute themselves, while skipping the
   * signature-verify step lets the composer render the "X searches left"
   * chip on every screen without constant resigning.
   */
  app.get(
    "/discovery/quota",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = discoveryQuotaQuerySchema.safeParse(request.query);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid query: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      try {
        const state = await readQuota(parse.data.wallet);
        return reply.status(200).send(state);
      } catch (err) {
        request.log.error(err, "Failed to read discovery quota");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to read discovery quota",
        });
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /*  GET /discovery/suggestions                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Suggestion prompts rendered in the empty composer. v1 is a static
   * seed covering the rules-resolver protocols; a future iteration can
   * enrich from the protocol registry's `supported_actions`, but for now
   * determinism + zero DB load is the right trade.
   */
  app.get(
    "/discovery/suggestions",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = discoverySuggestionsQuerySchema.safeParse(request.query);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid query: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const count = parse.data.count ?? SUGGESTIONS_DEFAULT;
      return reply.status(200).send({
        suggestions: SUGGESTION_SEED.slice(0, count),
      });
    },
  );
}
