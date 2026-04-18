import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { pool, query } from "../db/client.js";
import { requireWalletAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  AT_RISK_DAMPENER,
  FEATURED_BOOST,
} from "../services/ranking-engine.js";
import { discoveryQueue } from "../services/bullmq.js";
import { consumeQuota, readQuota } from "../services/discovery-quota.js";
import {
  formatAssistantText,
  resolverFellBackToRules,
} from "../services/discovery-format.js";
import { resolveIntent } from "../services/intent-resolver.js";
import { listActiveProtocols } from "../services/protocol-registry.js";
import { BASE58_PUBKEY } from "../types/solana.js";

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

/* -------------------------------------------------------------------------- */
/*  /discovery/schedule validation + helpers                                  */
/* -------------------------------------------------------------------------- */

const discoveryScheduleBodySchema = z.object({
  text: z.string().min(1).max(500),
  // Optional ISO timestamp. When absent we default to the next UTC
  // midnight — matches the "schedule for tomorrow" UX prompt in §7.6.
  runAt: z.string().datetime().optional(),
});

const scheduleIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Next UTC-midnight ISO string. Duplicates the internal helper in
 * discovery-quota.ts on purpose — exporting it would force that module
 * to broaden its public surface for a single caller, so we keep the
 * copy local and trivially verifiable.
 */
function nextUtcMidnightIso(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
  return next.toISOString();
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

        const protocols = await listActiveProtocols();
        const result = await resolveIntent(text, wallet, protocols);

        const matches = result.offers.map((o) => ({
          protocolId: o.protocol_id,
          protocolName: o.protocol_name,
          actionType: o.action_type,
          points: o.points,
        }));

        const fellBackToRules = resolverFellBackToRules(result);

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

  /* ------------------------------------------------------------------ */
  /*  POST /discovery/schedule                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Schedule a discovery query for a future UTC time. Creates a
   * `discovery_schedules` row in state `pending` AND enqueues a BullMQ
   * delayed job — atomically, so a failed Redis enqueue rolls back the
   * DB row and the caller sees 500 without an orphan schedule.
   *
   * Cap: `config.DISCOVERY_MAX_SCHEDULED` (default 5) concurrent
   * pending+running rows per wallet. The cap is checked inside the
   * same transaction as the INSERT so two parallel requests can't both
   * slip through at the boundary.
   *
   * Response 200 { id, wallet, text, runAt, status, createdAt }.
   */
  app.post(
    "/discovery/schedule",
    { preHandler: [requireWalletAuth, rateLimit(60_000, 30)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = discoveryScheduleBodySchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const wallet = request.walletAddress!;
      const { text } = parse.data;
      const runAt = parse.data.runAt
        ? new Date(parse.data.runAt)
        : new Date(nextUtcMidnightIso());

      const now = Date.now();
      if (runAt.getTime() <= now) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "runAt must be in the future",
        });
      }

      // Wrap the cap-check + INSERT + enqueue in a transaction so a
      // failed Redis enqueue can ROLLBACK the row. We also snapshot the
      // cap under `FOR UPDATE` semantics indirectly via a SERIALIZABLE
      // isolation level would be stronger, but the read-then-insert
      // pattern inside a transaction is sufficient for the UX-level
      // guarantee — the cap is a soft advisory limit, not a security
      // boundary.
      const client = await pool.connect();
      let scheduleId: string | null = null;
      let createdAt: string | null = null;
      try {
        await client.query("BEGIN");

        const capRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM discovery_schedules
            WHERE wallet = $1 AND status IN ('pending','running')`,
          [wallet],
        );
        const active = Number(capRes.rows[0]?.count ?? "0");
        if (active >= config.DISCOVERY_MAX_SCHEDULED) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "schedule_cap_reached",
            max: config.DISCOVERY_MAX_SCHEDULED,
          });
        }

        const insertRes = await client.query<{
          id: string;
          created_at: Date;
        }>(
          `INSERT INTO discovery_schedules (wallet, text, run_at, status)
             VALUES ($1, $2, $3, 'pending')
             RETURNING id, created_at`,
          [wallet, text, runAt.toISOString()],
        );
        scheduleId = insertRes.rows[0].id;
        createdAt = insertRes.rows[0].created_at.toISOString();

        // Enqueue inside the transaction so a failed add() forces a
        // ROLLBACK of the row. `jobId: scheduleId` makes the job
        // idempotently addressable by the DELETE endpoint without
        // tracking a separate BullMQ identifier.
        const delay = Math.max(0, runAt.getTime() - Date.now());
        const queue = discoveryQueue();
        const job = await queue.add(
          "discovery-run",
          { scheduleId, wallet, text },
          {
            delay,
            jobId: scheduleId,
            removeOnComplete: true,
            removeOnFail: false,
            // Transient worker errors (Gemini hiccup, DB blip) shouldn't
            // silently drop a scheduled run. BullMQ retries up to 3 times
            // with exponential backoff starting at 30s — well inside the
            // user-perceived "scheduled for tomorrow" tolerance while
            // still bounded enough that a truly broken job gives up.
            attempts: 3,
            backoff: { type: "exponential", delay: 30_000 },
          },
        );

        await client.query(
          `UPDATE discovery_schedules SET bullmq_id = $1 WHERE id = $2`,
          [job.id ?? scheduleId, scheduleId],
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error(err, "Failed to schedule discovery run");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to schedule discovery run",
        });
      } finally {
        client.release();
      }

      return reply.status(200).send({
        id: scheduleId,
        wallet,
        text,
        runAt: runAt.toISOString(),
        status: "pending",
        createdAt,
      });
    },
  );

  /* ------------------------------------------------------------------ */
  /*  GET /discovery/scheduled                                          */
  /* ------------------------------------------------------------------ */

  /**
   * List the authenticated wallet's pending/running schedules. Sorted
   * by `run_at` ascending so the composer's "upcoming" list renders in
   * chronological order without client-side sorting.
   */
  app.get(
    "/discovery/scheduled",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const wallet = request.walletAddress!;
      try {
        const result = await query<{
          id: string;
          wallet: string;
          text: string;
          run_at: Date;
          status: string;
          created_at: Date;
        }>(
          `SELECT id, wallet, text, run_at, status, created_at
             FROM discovery_schedules
            WHERE wallet = $1 AND status IN ('pending','running')
            ORDER BY run_at ASC`,
          [wallet],
        );

        return reply.status(200).send({
          items: result.rows.map((r) => ({
            id: r.id,
            wallet: r.wallet,
            text: r.text,
            runAt: r.run_at.toISOString(),
            status: r.status,
            createdAt: r.created_at.toISOString(),
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to list discovery schedules");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to list discovery schedules",
        });
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /*  DELETE /discovery/scheduled/:id                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Cancel a pending/running schedule. Removes the BullMQ job so it
   * never fires AND updates the DB row to `cancelled`. The BullMQ
   * remove() may fail harmlessly if the job has already been processed
   * or previously removed — we swallow that case because the DB status
   * update is the source of truth for the UI.
   *
   * Auth: the caller must own the schedule. A wallet-mismatch returns
   * 403, a missing id 404, an already-terminal status 409.
   */
  app.delete<{ Params: { id: string } }>(
    "/discovery/scheduled/:id",
    { preHandler: [requireWalletAuth] },
    async (request, reply) => {
      const parse = scheduleIdParamsSchema.safeParse(request.params);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid id: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const wallet = request.walletAddress!;
      const { id } = parse.data;

      try {
        const row = await query<{
          wallet: string;
          status: string;
          bullmq_id: string | null;
        }>(
          `SELECT wallet, status, bullmq_id
             FROM discovery_schedules
            WHERE id = $1`,
          [id],
        );

        if (row.rowCount === 0) {
          return reply.status(404).send({
            error: "Not Found",
            message: "Schedule not found",
          });
        }

        const record = row.rows[0];
        if (record.wallet !== wallet) {
          return reply.status(403).send({
            error: "Forbidden",
            message: "Schedule access denied",
          });
        }

        if (record.status !== "pending" && record.status !== "running") {
          return reply.status(409).send({
            error: "not_cancellable",
            status: record.status,
          });
        }

        // Best-effort queue removal. If the job is already processed or
        // was never linked (bullmq_id null from a mid-transaction crash)
        // we still want the DB status to flip to 'cancelled'.
        const jobId = record.bullmq_id ?? id;
        try {
          await discoveryQueue().remove(jobId);
        } catch (err) {
          request.log.warn(
            { err, scheduleId: id, jobId },
            "BullMQ remove failed; proceeding with DB cancel",
          );
        }

        await query(
          `UPDATE discovery_schedules SET status = 'cancelled' WHERE id = $1`,
          [id],
        );

        return reply.status(204).send();
      } catch (err) {
        request.log.error(err, "Failed to cancel discovery schedule");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to cancel discovery schedule",
        });
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /*  GET /discovery/results                                            */
  /* ------------------------------------------------------------------ */

  /**
   * List completed scheduled-discovery results for the authenticated
   * wallet. Joined against `discovery_schedules` so each row carries
   * the original prompt + scheduled time — the client can render the
   * history view without a second lookup. Capped at 50 rows (most
   * recent first); pagination can be added when the UX demands it.
   */
  app.get(
    "/discovery/results",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const wallet = request.walletAddress!;
      try {
        const result = await query<{
          schedule_id: string;
          assistant: unknown;
          matches: unknown;
          fell_back: boolean;
          completed_at: Date;
          text: string;
          run_at: Date;
        }>(
          `SELECT r.schedule_id,
                  r.assistant,
                  r.matches,
                  r.fell_back,
                  r.completed_at,
                  s.text,
                  s.run_at
             FROM discovery_results r
             JOIN discovery_schedules s ON r.schedule_id = s.id
            WHERE s.wallet = $1
            ORDER BY r.completed_at DESC
            LIMIT 50`,
          [wallet],
        );

        return reply.status(200).send({
          items: result.rows.map((r) => ({
            scheduleId: r.schedule_id,
            assistant: r.assistant,
            matches: r.matches,
            fellBack: r.fell_back,
            completedAt: r.completed_at.toISOString(),
            text: r.text,
            runAt: r.run_at.toISOString(),
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to list discovery results");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to list discovery results",
        });
      }
    },
  );
}
