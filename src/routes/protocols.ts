import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { requireBearerAuth, requireProtocolOwner } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { query, pool } from "../db/client.js";
import { league } from "../config.js";
import { BASE58_PUBKEY } from "../types/solana.js";
import { capacityBaseline as capacityBaselineOf } from "../services/capacity.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Register-protocol body schema.
 *
 *   - `name`: trimmed, 3..80 chars.
 *   - `description`: empty string coerced to null so we don't persist
 *     whitespace the UI submits by accident.
 *   - `blink_base_url`: empty string coerced to null; otherwise must
 *     parse as an http(s) URL.
 *   - `supported_actions`: array of trimmed, deduplicated non-empty
 *     strings ≤48 chars. Duplicates are collapsed server-side so the
 *     DB doesn't grow bigger than the UI implied.
 */
const REGISTER_BODY_SCHEMA = z
  .object({
    name: z
      .string()
      .transform((s) => s.trim())
      .pipe(
        z
          .string()
          .min(3, "name must be at least 3 characters")
          .max(80, "name must be 80 characters or fewer"),
      ),
    description: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().max(500, "description must be 500 characters or fewer"))
      .transform((s) => (s.length === 0 ? null : s))
      .nullable()
      .optional(),
    blink_base_url: z
      .string()
      .transform((s) => s.trim())
      .pipe(
        z.string().max(500, "blink_base_url must be 500 characters or fewer"),
      )
      .transform((s) => (s.length === 0 ? null : s))
      .nullable()
      .optional()
      .refine(
        (v) => v == null || /^https?:\/\/[^\s]+$/i.test(v),
        "blink_base_url must start with http:// or https://",
      ),
    supported_actions: z
      .array(
        z
          .string()
          .transform((s) => s.trim())
          .pipe(
            z
              .string()
              .min(1, "supported_actions entries must not be empty")
              .max(48, "supported_actions entries must be ≤48 chars"),
          ),
      )
      .optional()
      .transform((arr) => (arr ? Array.from(new Set(arr)) : arr)),
  })
  .strict();

type RegisterBody = z.infer<typeof REGISTER_BODY_SCHEMA>;

/**
 * Narrow a caught error to Postgres's unique-violation code (`23505`).
 * `pg` surfaces this as a string `.code` on the error object. We lean
 * on duck-typing rather than importing `pg` types here because the
 * rest of this file uses the string-based codes consistently and
 * adding a type import for one branch isn't worth the churn.
 */
function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

interface ProtocolParams {
  id: string;
}

interface PatchBody {
  name?: string;
  description?: string;
  blink_base_url?: string;
  supported_actions?: string[];
}

interface LeagueJoinBody {
  founder_wallets?: string[];
  team_wallets?: string[];
}

interface CreateQuestBody {
  name: string;
  description?: string;
  quest_type?: string;
  reward_points?: number;
  max_participants?: number;
  steps?: Array<{
    intent_type: string;
    params?: Record<string, unknown>;
    points?: number;
  }>;
  start_at?: string;
  end_at?: string;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function protocolRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /protocols/register ------
   *
   * Auth: `requireBearerAuth`. The original gate was `requireWalletAuth`
   * (static-message ed25519 signature in the `x-wallet-*` headers), but
   * the console already signs in via `/v1/auth/challenge` + `/v1/auth/verify`
   * and holds a bearer JWT — asking the admin to re-sign a second message
   * to register is friction with no security win (the JWT is itself
   * rooted in a fresh wallet signature). No external client called this
   * route with wallet headers, so the switch is non-breaking.
   *
   * The authenticated wallet becomes the `admin_wallet` on the new row,
   * so protocol ownership is attributed purely to the signed-in identity
   * — the body never gets to name a different wallet.
   *
   * Schema invariant: `protocols.admin_wallet` is UNIQUE (migration 003).
   * MVP policy is **one protocol per wallet**. We pre-check to return a
   * friendly 409 rather than a 500 from the generic catch; the catch
   * still traps the `23505` unique-violation for the TOCTOU race between
   * two concurrent register requests from the same wallet (e.g. double-
   * clicked submit). Admins with an existing protocol use PATCH to
   * update metadata; key loss is recoverable via the rotate endpoint.
   *
   * Rate limit: 5 requests / 60s per wallet-bound rate-limit key. Sized
   * so a human can retry after a validation failure but a bot can't
   * farm inserts. See `middleware/rate-limit.ts` for the key derivation.
   *
   * Status: hard-written as `'active'` even though the schema default is
   * `'pending'`. MVP policy is self-serve activation — there's no
   * moderation queue. If that changes, move registration to 'pending'
   * and gate activation on a separate approval flow.
   *
   * Response includes the raw `api_key` exactly once. The admin must
   * persist it client-side; only the sha-256 hash is stored server-side.
   */
  app.post(
    "/protocols/register",
    { preHandler: [requireBearerAuth, rateLimit(60_000, 5)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const walletAddress = request.walletAddress!;

      const parsed = REGISTER_BODY_SCHEMA.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        });
      }
      const body: RegisterBody = parsed.data;

      // Pre-check: does this wallet already own a protocol? Returns a
      // structured 409 with the existing protocol_id so the console can
      // route the admin to the dashboard instead of rendering the form
      // a second time. This is the humane path; the catch below handles
      // the race where two requests land between this SELECT and the
      // INSERT.
      const existing = await query<{ id: string }>(
        `SELECT id FROM protocols WHERE admin_wallet = $1 LIMIT 1`,
        [walletAddress],
      );
      if ((existing.rowCount ?? 0) > 0) {
        return reply.status(409).send({
          error: "Conflict",
          message:
            "Wallet already owns a protocol. One protocol per wallet is the current policy — use PATCH /v1/protocols/:id to update or POST /v1/protocols/:id/rotate-api-key to reset the api key.",
          protocol_id: existing.rows[0].id,
        });
      }

      try {
        // Generate a raw API key and store its hash.
        const rawApiKey = `rwz_${crypto.randomUUID().replace(/-/g, "")}`;
        const apiKeyHash = crypto
          .createHash("sha256")
          .update(rawApiKey)
          .digest("hex");

        const result = await query<{ id: string; created_at: Date }>(
          `INSERT INTO protocols (admin_wallet, name, description, blink_base_url, supported_actions, api_key_hash, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')
           RETURNING id, created_at`,
          [
            walletAddress,
            body.name,
            body.description ?? null,
            body.blink_base_url ?? null,
            body.supported_actions ?? [],
            apiKeyHash,
          ],
        );

        return reply.status(201).send({
          protocol_id: result.rows[0].id,
          admin_wallet: walletAddress,
          api_key: rawApiKey,
          name: body.name,
          status: "active",
          created_at: result.rows[0].created_at,
        });
      } catch (err) {
        // Catch the unique-violation that slipped past the pre-check via
        // a TOCTOU race. Pull the actual id so the client still gets a
        // usable handle — the race resolves to "pick one winner".
        if (isPgUniqueViolation(err)) {
          const race = await query<{ id: string }>(
            `SELECT id FROM protocols WHERE admin_wallet = $1 LIMIT 1`,
            [walletAddress],
          );
          return reply.status(409).send({
            error: "Conflict",
            message:
              "Wallet already owns a protocol (race detected). Retry against the existing id.",
            protocol_id: race.rows[0]?.id ?? null,
          });
        }
        request.log.error(err, "Failed to register protocol");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to register protocol",
        });
      }
    },
  );

  /* ------ POST /protocols/:id/rotate-api-key ------
   *
   * Mint a fresh api key for a protocol the signed-in wallet owns.
   * Covers two cases:
   *   1. Admin registered but didn't copy the key off the success screen
   *      and refreshed the page — the key is lost to them (we only
   *      persist the hash).
   *   2. Admin believes the key has leaked and needs to invalidate any
   *      in-flight external clients immediately.
   * Response shape matches the relevant subset of /register so the
   * console can reuse its "save this now" surface verbatim.
   */
  app.post<{ Params: ProtocolParams }>(
    "/protocols/:id/rotate-api-key",
    {
      preHandler: [
        requireBearerAuth,
        requireProtocolOwner,
        rateLimit(60_000, 5),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const rawApiKey = `rwz_${crypto.randomUUID().replace(/-/g, "")}`;
        const apiKeyHash = crypto
          .createHash("sha256")
          .update(rawApiKey)
          .digest("hex");

        const result = await query<{
          name: string;
          admin_wallet: string;
          status: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `UPDATE protocols
              SET api_key_hash = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING name, admin_wallet, status, created_at, updated_at`,
          [apiKeyHash, id],
        );
        if (result.rowCount === 0) {
          // requireProtocolOwner already covers this case, but belt-and-
          // braces — if the row was deleted between the preHandler and
          // the UPDATE we still want to return a sensible status.
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Protocol not found" });
        }

        const row = result.rows[0];
        return reply.status(200).send({
          protocol_id: id,
          admin_wallet: row.admin_wallet,
          api_key: rawApiKey,
          name: row.name,
          status: row.status,
          created_at: row.created_at.toISOString(),
          rotated_at: row.updated_at.toISOString(),
        });
      } catch (err) {
        request.log.error(err, "Failed to rotate api key");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to rotate api key",
        });
      }
    },
  );

  /* ------ GET /protocols ------ */
  app.get(
    "/protocols",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await query(
          `SELECT id, name, description, blink_base_url, supported_actions,
                  trust_score, status, created_at
           FROM protocols
           WHERE status = 'active'
           ORDER BY trust_score DESC, created_at DESC`,
        );

        return reply.status(200).send({ protocols: result.rows });
      } catch (err) {
        _request.log.error(err, "Failed to list protocols");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to list protocols",
        });
      }
    },
  );

  /* ------ GET /protocols/me ------
   *
   * Return every protocol owned by the bearer-authenticated wallet,
   * most-recent first. The console uses this to resolve which protocol
   * to show without needing a PROTOCOL_ID env var — the source of
   * truth for "which protocol is this wallet's" is the DB, not a
   * deploy-time constant.
   *
   * Note: we list every status, not just 'active'. The console can filter
   * downstream; showing a disabled / suspended row with its status tag
   * is better UX than pretending it doesn't exist when the admin tries
   * to investigate why they can't issue points.
   */
  app.get(
    "/protocols/me",
    { preHandler: [requireBearerAuth] },
    async (request, reply) => {
      const walletAddress = request.walletAddress!;
      try {
        const result = await query<{
          id: string;
          name: string;
          description: string | null;
          blink_base_url: string | null;
          supported_actions: string[];
          trust_score: number;
          status: string;
          created_at: Date;
        }>(
          `SELECT id, name, description, blink_base_url, supported_actions,
                  trust_score, status, created_at
             FROM protocols
            WHERE admin_wallet = $1
            ORDER BY created_at DESC`,
          [walletAddress],
        );

        return reply.status(200).send({
          wallet: walletAddress,
          protocols: result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            blink_base_url: row.blink_base_url,
            supported_actions: row.supported_actions,
            trust_score: row.trust_score,
            status: row.status,
            created_at: row.created_at.toISOString(),
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to list protocols for wallet");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to list protocols",
        });
      }
    },
  );

  /* ------ PATCH /protocols/:id ------
   *
   * Protected by `requireBearerAuth + requireProtocolOwner` (plan task
   * 38). The old API-key gate is retired for :id/* routes — the
   * console flow exclusively uses wallet-signed JWTs from
   * /v1/auth/verify. External protocols that still need API-key
   * access should call the channel-specific routes under
   * /v1/points/* instead.
   */
  app.patch<{ Params: ProtocolParams; Body: PatchBody }>(
    "/protocols/:id",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as PatchBody | undefined;

      if (
        !body ||
        (!body.name &&
          !body.description &&
          !body.blink_base_url &&
          !body.supported_actions)
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "At least one field to update is required",
        });
      }

      try {
        const setClauses: string[] = ["updated_at = NOW()"];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (body.name) {
          setClauses.push(`name = $${paramIdx++}`);
          params.push(body.name);
        }
        if (body.description !== undefined) {
          setClauses.push(`description = $${paramIdx++}`);
          params.push(body.description);
        }
        if (body.blink_base_url !== undefined) {
          setClauses.push(`blink_base_url = $${paramIdx++}`);
          params.push(body.blink_base_url);
        }
        if (body.supported_actions) {
          setClauses.push(`supported_actions = $${paramIdx++}`);
          params.push(body.supported_actions);
        }

        params.push(id);

        const result = await query(
          `UPDATE protocols SET ${setClauses.join(", ")} WHERE id = $${paramIdx}
           RETURNING id, admin_wallet, name, description, blink_base_url, supported_actions, trust_score, status, created_at, updated_at`,
          params,
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Protocol not found" });
        }

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to update protocol");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to update protocol",
        });
      }
    },
  );

  /* ------ POST /protocols/:id/quests ------
   *
   * Protected by `requireBearerAuth + requireProtocolOwner` (plan task
   * 38). Same rationale as PATCH /protocols/:id above.
   */
  app.post<{ Params: ProtocolParams; Body: CreateQuestBody }>(
    "/protocols/:id/quests",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as CreateQuestBody | undefined;

      if (!body?.name) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: "name is required" });
      }

      try {
        const questType = body.quest_type ?? "single";
        const conditions = JSON.stringify({
          steps_required: body.steps?.length ?? 1,
        });
        const result = await query<{ quest_id: string; created_at: Date }>(
          `INSERT INTO quests (created_by, name, description, quest_type, conditions, reward_points, max_participants, start_at, end_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
           RETURNING quest_id, created_at`,
          [
            id,
            body.name,
            body.description ?? null,
            questType,
            conditions,
            body.reward_points ?? 0,
            body.max_participants ?? null,
            body.start_at ?? null,
            body.end_at ?? null,
          ],
        );

        const questId = result.rows[0].quest_id;

        // Insert quest steps if provided
        if (body.steps && body.steps.length > 0) {
          for (let i = 0; i < body.steps.length; i++) {
            const step = body.steps[i];
            await query(
              `INSERT INTO quest_steps (quest_id, step_index, intent_type, params, points)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                questId,
                i,
                step.intent_type,
                JSON.stringify(step.params ?? {}),
                step.points ?? 0,
              ],
            );
          }
        }

        return reply.status(201).send({
          quest_id: questId,
          protocol_id: id,
          name: body.name,
          quest_type: questType,
          status: "active",
          created_at: result.rows[0].created_at,
        });
      } catch (err) {
        request.log.error(err, "Failed to create quest");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to create quest",
        });
      }
    },
  );

  /* ------ GET /protocols/:id/overview ------
   *
   * Dashboard Overview tab data (plan task 41). Returns the protocol
   * header, stake status stub, active campaigns count, total points
   * issued across all seasons, and a small recent-activity slice.
   * Protected by `requireBearerAuth + requireProtocolOwner`.
   */
  app.get<{ Params: ProtocolParams }>(
    "/protocols/:id/overview",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const protoRes = await query<{
          id: string;
          name: string;
          admin_wallet: string;
          trust_score: number;
        }>(
          `SELECT id, name, admin_wallet, trust_score
             FROM protocols WHERE id = $1 LIMIT 1`,
          [id],
        );

        if (protoRes.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Protocol not found" });
        }
        const proto = protoRes.rows[0];

        // Points issued across all point_events for this protocol.
        const pointsRes = await query<{ total_points_issued: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS total_points_issued
             FROM point_events
            WHERE protocol_id = $1`,
          [id],
        );

        // Live campaigns count — `live` is the new state-machine value,
        // `active` is the legacy default pre-Phase-5. Count either.
        const liveCountRes = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM campaigns
            WHERE protocol_id = $1
              AND status IN ('live', 'active')`,
          [id],
        );

        const recentRes = await query<{
          id: string;
          user_wallet: string;
          amount: string;
          reason: string | null;
          created_at: Date;
        }>(
          `SELECT id, user_wallet,
                  amount::text AS amount,
                  reason, created_at
             FROM point_events
            WHERE protocol_id = $1
            ORDER BY created_at DESC
            LIMIT 10`,
          [id],
        );

        return reply.status(200).send({
          protocolId: proto.id,
          name: proto.name,
          trustBadge: proto.trust_score,
          adminWallet: proto.admin_wallet,
          stakeStatus: {
            amount: "0",
            eligibility: "staked-min",
          },
          activeCampaignsCount: Number(liveCountRes.rows[0]?.count ?? "0"),
          totalPointsIssued: pointsRes.rows[0].total_points_issued,
          recentActivity: recentRes.rows.map((row) => ({
            id: row.id,
            userWallet: row.user_wallet,
            amount: row.amount,
            reason: row.reason,
            createdAt: row.created_at.toISOString(),
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch protocol overview");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch protocol overview",
        });
      }
    },
  );

  /* ------ GET /protocols/:id/stake ------
   *
   * Plan task 41. Protocol stake amount / lock end / eligibility.
   * Protocol stake data isn't wired yet (stake is a future on-chain
   * concern), so this stub returns safe defaults. Protected by
   * `requireBearerAuth + requireProtocolOwner`.
   */
  app.get<{ Params: ProtocolParams }>(
    "/protocols/:id/stake",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id } = request.params;

      // The requireProtocolOwner middleware already asserted the
      // protocol exists + belongs to the caller, so we can respond
      // directly with the stub shape.
      // TODO: wire from chain or stake events table once the protocol
      // stake on-chain surface lands in Session 4.
      return reply.status(200).send({
        protocolId: id,
        amount: "0",
        lockEnd: null,
        eligibility: "staked-min",
        credit: null,
      });
    },
  );

  /* ------ GET /protocols/:id/performance ------
   *
   * Plan task 41. Completion rate, points over time, engagement stats,
   * trust score. Protected by `requireBearerAuth + requireProtocolOwner`.
   * MVP stubs trustScore at 100 and derives what it can from
   * point_events + campaigns.
   */
  app.get<{ Params: ProtocolParams }>(
    "/protocols/:id/performance",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        // Points issued grouped by day, last 30 days.
        const seriesRes = await query<{ day: string; points: string }>(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                  COALESCE(SUM(amount), 0)::text                       AS points
             FROM point_events
            WHERE protocol_id = $1
              AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY 1
            ORDER BY 1`,
          [id],
        );

        // Engagement: unique wallets vs returning (≥2 awards).
        const engagementRes = await query<{
          unique_users: string;
          returning_users: string;
        }>(
          `WITH counts AS (
             SELECT user_wallet, COUNT(*) AS n
               FROM point_events
              WHERE protocol_id = $1
              GROUP BY user_wallet
           )
           SELECT COUNT(*)::text                         AS unique_users,
                  COUNT(*) FILTER (WHERE n >= 2)::text   AS returning_users
             FROM counts`,
          [id],
        );

        // Completion rate needs a denominator. TODO: wire from intent
        // attempts / completions table join once the completions
        // pipeline exposes per-protocol attempt counts. For now, use
        // completed / (completed + 0) guarded so the response still has
        // a numeric field.
        // TODO: proper completion rate numerator + denominator from
        // completions + campaigns.awarded_count totals.
        const completionRes = await query<{ completed: string }>(
          `SELECT COALESCE(SUM(awarded_count), 0)::text AS completed
             FROM campaigns
            WHERE protocol_id = $1`,
          [id],
        );
        const completed = Number(completionRes.rows[0]?.completed ?? "0");
        const completionRate = completed === 0 ? 0 : 1;

        return reply.status(200).send({
          protocolId: id,
          completionRate,
          pointsIssuedOverTime: seriesRes.rows.map((row) => ({
            date: row.day,
            points: row.points,
          })),
          engagement: {
            uniqueUsers: Number(engagementRes.rows[0]?.unique_users ?? "0"),
            returningUsers: Number(
              engagementRes.rows[0]?.returning_users ?? "0",
            ),
          },
          // TODO: compute from trust_score + dispute_rate + fraud_rate
          // once the trust model is finalised. For MVP we stub at 100.
          trustScore: 100,
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch protocol performance");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch protocol performance",
        });
      }
    },
  );

  /* ------ GET /protocols/:id/league/status ------
   *
   * Plan task 19. Consolidated league-state readout for the
   * protocol-console dashboard and SDK. Returns visibility,
   * remaining issuance capacity, quality score, open abuse flags,
   * sum of unpublished Rewardz earnings, registered wallet weights,
   * and the most recent protocol_events (for banners). Protected by
   * `requireBearerAuth + requireProtocolOwner` — a protocol's league
   * status is sensitive (capacity baseline, abuse flags) so only the
   * owner sees it. Discovery surfaces go through /intents/resolve +
   * /discovery/featured which already filter on visibility.
   */
  app.get<{ Params: ProtocolParams }>(
    "/protocols/:id/league/status",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const protoRes = await query<{
          id: string;
          admin_wallet: string;
          visibility: string | null;
          quality_score: string | null;
          remaining_capacity: string | null;
          capacity_window_start: Date | null;
          referral_code: string | null;
          founder_wallets: string[];
          team_wallets: string[];
          active_stake: string | null;
        }>(
          `SELECT id, admin_wallet, visibility,
                  quality_score::text AS quality_score,
                  remaining_capacity::text AS remaining_capacity,
                  capacity_window_start, referral_code,
                  founder_wallets, team_wallets,
                  active_stake::text AS active_stake
             FROM protocols WHERE id = $1 LIMIT 1`,
          [id],
        );

        if (protoRes.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Protocol not found" });
        }
        const proto = protoRes.rows[0];

        // Open abuse flags (resolved_at IS NULL), grouped by kind/severity.
        const flagsRes = await query<{
          kind: string;
          severity: string;
          created_at: Date;
        }>(
          `SELECT kind, severity, created_at
             FROM abuse_flags
            WHERE protocol_id = $1
              AND resolved_at IS NULL
            ORDER BY created_at DESC`,
          [id],
        );

        // Sum unpublished Rewardz earnings (what a claim_rewardz would
        // be able to pull once the next root epoch publishes).
        const pendingRes = await query<{ pending: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS pending
             FROM rewardz_earnings
            WHERE protocol_id = $1
              AND included_in_root_epoch IS NULL`,
          [id],
        );

        const weightsRes = await query<{
          wallet: string;
          role: string;
          weight: string;
        }>(
          `SELECT wallet, role, weight::text AS weight
             FROM wallet_weights
            WHERE protocol_id = $1
            ORDER BY role, wallet`,
          [id],
        );

        const eventsRes = await query<{
          id: string;
          kind: string;
          level: string;
          payload: unknown;
          created_at: Date;
        }>(
          `SELECT id::text AS id, kind, level, payload, created_at
             FROM protocol_events
            WHERE protocol_id = $1
            ORDER BY created_at DESC
            LIMIT 10`,
          [id],
        );

        // Capacity baseline (task 16a): derived via the shared
        // `capacityBaseline()` helper so the console's percentage
        // math stays locked to the same rule the server uses when
        // emitting threshold-crossing events. See
        // api/src/services/capacity.ts.
        const activeStake =
          proto.active_stake == null ? null : BigInt(proto.active_stake);
        const baseline = capacityBaselineOf(activeStake);

        // camelCase keys mirror sibling dashboard handlers in this file
        // (/overview at :290, /performance at :414). BigInt-like columns
        // (remainingCapacity, pendingRewardz, capacityBaseline) are left
        // as strings to avoid JS Number precision loss; qualityScore is
        // bounded 0..1 so Number() is safe.
        return reply.status(200).send({
          protocolId: proto.id,
          adminWallet: proto.admin_wallet,
          visibility: proto.visibility ?? "active",
          qualityScore:
            proto.quality_score == null ? null : Number(proto.quality_score),
          remainingCapacity: proto.remaining_capacity,
          capacityWindowStart:
            proto.capacity_window_start?.toISOString() ?? null,
          capacityBaseline: baseline.toString(),
          activeStake: proto.active_stake,
          referralCode: proto.referral_code,
          founderWallets: proto.founder_wallets,
          teamWallets: proto.team_wallets,
          pendingRewardz: pendingRes.rows[0].pending,
          openAbuseFlags: flagsRes.rows.map((r) => ({
            kind: r.kind,
            severity: r.severity,
            createdAt: r.created_at.toISOString(),
          })),
          walletWeights: weightsRes.rows.map((r) => ({
            wallet: r.wallet,
            role: r.role,
            weight: Number(r.weight),
          })),
          recentEvents: eventsRes.rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            level: r.level,
            payload: r.payload,
            createdAt: r.created_at.toISOString(),
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch league status");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch league status",
        });
      }
    },
  );

  /* ------ POST /protocols/:id/league/join ------
   *
   * Plan task 20. Joins a protocol to the Colosseum Rewardz League:
   *   1. Generates a unique referral code (used by /referrals/attribute
   *      in task 21) and persists declared founder/team wallets.
   *   2. Inserts a `rewardz_earnings` row for the starter grant
   *      (reason='starter_grant', milestone_id=NULL). The partial
   *      UNIQUE index from migration 045
   *      (`rewardz_earnings(protocol_id, reason) WHERE milestone_id IS NULL`)
   *      makes this insert idempotent at the DB layer — re-joining
   *      the same protocol cannot double-pay.
   *   3. Seeds `wallet_weights` rows for declared founder/team wallets
   *      using the per-role weights from `league-config.md`. The
   *      admin_wallet is added as a founder automatically so the
   *      milestone-processor's anti-abuse math always has a weight
   *      row for the protocol's primary operator.
   *   4. Emits a `protocol_events` row (`kind='league_joined'`,
   *      level='info') so the console can surface the action in its
   *      activity feed.
   *
   * Capacity is deliberately NOT initialised here. Per league-config.md,
   * remaining_capacity is unlocked by staking the starter grant
   * (task 16a). Join writes the ledger row; the stake-watcher debits
   * from the ledger once the on-chain stake is observed.
   *
   * Idempotency: calling league/join on a protocol that has already
   * joined (non-null referral_code AND a starter_grant earnings row)
   * returns 200 with the existing state rather than 409 — joining is
   * a one-shot lifecycle event, and a retry after a flaky response
   * should not surface as an error. All four write paths use
   * conflict-safe inserts so a partial previous attempt is completed
   * rather than duplicated.
   *
   * Protected by `requireBearerAuth + requireProtocolOwner`.
   */
  app.post<{ Params: ProtocolParams; Body: LeagueJoinBody }>(
    "/protocols/:id/league/join",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};

      // Guard against non-array bodies BEFORE calling .filter. A caller
      // who sends `{"founder_wallets": "abc"}` (string, not array) would
      // otherwise hit `.filter is not a function`, fall through to the
      // generic catch, and surface as a 500 — which masks a plain
      // client-side error as a server fault.
      if (
        body.founder_wallets !== undefined &&
        !Array.isArray(body.founder_wallets)
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "founder_wallets must be an array",
        });
      }
      if (
        body.team_wallets !== undefined &&
        !Array.isArray(body.team_wallets)
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "team_wallets must be an array",
        });
      }

      // Validate declared wallets are plausible base58 pubkeys. Uses
      // the shared BASE58_PUBKEY regex so config/auth/protocols cannot
      // drift on what "valid wallet" means.
      const founderWallets = (body.founder_wallets ?? []).filter(
        (w) => typeof w === "string" && BASE58_PUBKEY.test(w),
      );
      const teamWallets = (body.team_wallets ?? []).filter(
        (w) => typeof w === "string" && BASE58_PUBKEY.test(w),
      );
      if (
        (body.founder_wallets?.length ?? 0) !== founderWallets.length ||
        (body.team_wallets?.length ?? 0) !== teamWallets.length
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message:
            "founder_wallets and team_wallets must be arrays of base58 Solana pubkeys",
        });
      }

      // Initial SELECT runs outside the transaction — it's pure read,
      // doesn't need the BEGIN/COMMIT envelope, and a 404 should not
      // hold a pooled client hostage through a tx round-trip.
      const protoRes = await query<{
        admin_wallet: string;
        referral_code: string | null;
      }>(
        `SELECT admin_wallet, referral_code FROM protocols
          WHERE id = $1 LIMIT 1`,
        [id],
      );
      if (protoRes.rowCount === 0) {
        return reply
          .status(404)
          .send({ error: "Not Found", message: "Protocol not found" });
      }
      const { admin_wallet: adminWallet, referral_code: existingReferralCode } =
        protoRes.rows[0];

      // Admin is always a founder — merge into declared list so the
      // caller does not have to remember to include their own
      // wallet. De-dupe via Set.
      const foundersFinal = Array.from(
        new Set([adminWallet, ...founderWallets]),
      );
      const teamFinal = Array.from(new Set(teamWallets)).filter(
        (w) => !foundersFinal.includes(w),
      );

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Generate a unique referral_code if the protocol does not
        // already have one. Bounded retry — the keyspace (31^6 ≈ 887M)
        // combined with a partial UNIQUE index on non-null codes means
        // collisions are pathological; 3 attempts is plenty. If the
        // UPDATE's `referral_code IS NULL` guard loses a race, the
        // losing caller just re-reads on its next outer request —
        // there is no benefit to re-reading here.
        let referralCode = existingReferralCode;
        if (!referralCode) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const candidate = generateReferralCode();
            const upd = await client.query<{ referral_code: string }>(
              `UPDATE protocols
                  SET referral_code = $2,
                      founder_wallets = $3,
                      team_wallets = $4,
                      updated_at = NOW()
                WHERE id = $1
                  AND referral_code IS NULL
                RETURNING referral_code`,
              [id, candidate, foundersFinal, teamFinal],
            );
            if (upd.rowCount && upd.rowCount > 0) {
              referralCode = upd.rows[0].referral_code;
              break;
            }
          }
          if (!referralCode) {
            await client.query("ROLLBACK");
            return reply.status(500).send({
              error: "Internal Server Error",
              message: "Failed to allocate referral code",
            });
          }
        } else {
          // Protocol already has a code — update declared wallet
          // arrays idempotently so callers can amend a join.
          await client.query(
            `UPDATE protocols
                SET founder_wallets = $2,
                    team_wallets = $3,
                    updated_at = NOW()
              WHERE id = $1`,
            [id, foundersFinal, teamFinal],
          );
        }

        // Starter-grant Rewardz earnings row. Migration 045's partial
        // UNIQUE on (protocol_id, reason) WHERE milestone_id IS NULL
        // makes this insert at-most-once per protocol.
        const starter = league.starter_grant_rewardz;
        const starterInsert = await client.query<{ id: string }>(
          `INSERT INTO rewardz_earnings
              (protocol_id, protocol_authority, amount, reason, milestone_id)
           VALUES ($1, $2, $3::bigint, 'starter_grant', NULL)
           ON CONFLICT (protocol_id, reason) WHERE milestone_id IS NULL
           DO NOTHING
           RETURNING id::text AS id`,
          [id, adminWallet, starter],
        );
        const starterGrantIssued = (starterInsert.rowCount ?? 0) > 0;

        // Wallet weights — founder=0.25, team=0.5. External weights are
        // applied by milestone-processor at award time, not seeded here.
        // Use ON CONFLICT DO UPDATE so re-join with revised founder/team
        // lists moves a wallet between roles instead of failing.
        // Batched via unnest() so a protocol with dozens of team
        // wallets does one round-trip instead of dozens.
        const weightWallets = [...foundersFinal, ...teamFinal];
        const weightRoles = [
          ...foundersFinal.map(() => "founder"),
          ...teamFinal.map(() => "team"),
        ];
        const weightValues = [
          ...foundersFinal.map(() => league.wallet_weights.founder),
          ...teamFinal.map(() => league.wallet_weights.team),
        ];
        if (weightWallets.length > 0) {
          await client.query(
            `INSERT INTO wallet_weights (protocol_id, wallet, role, weight)
             SELECT $1, w.wallet, w.role, w.weight
               FROM unnest($2::text[], $3::text[], $4::numeric[])
                    AS w(wallet, role, weight)
             ON CONFLICT (protocol_id, wallet)
             DO UPDATE SET role = EXCLUDED.role, weight = EXCLUDED.weight`,
            [id, weightWallets, weightRoles, weightValues],
          );
        }

        await client.query(
          `INSERT INTO protocol_events (protocol_id, kind, level, payload)
           VALUES ($1, 'league_joined', 'info', $2::jsonb)`,
          [
            id,
            JSON.stringify({
              starter_grant_rewardz: starter,
              starter_grant_issued: starterGrantIssued,
              referral_code: referralCode,
              founder_count: foundersFinal.length,
              team_count: teamFinal.length,
            }),
          ],
        );

        await client.query("COMMIT");

        // camelCase keys mirror sibling dashboard handlers in this file
        // (/overview, /performance, /league/status).
        return reply.status(200).send({
          protocolId: id,
          referralCode: referralCode,
          starterGrantRewardz: starter,
          starterGrantIssued: starterGrantIssued,
          founderWallets: foundersFinal,
          teamWallets: teamFinal,
          walletWeightsCount: weightWallets.length,
        });
      } catch (err) {
        await client
          .query("ROLLBACK")
          .catch((rollbackErr) =>
            request.log.warn(rollbackErr, "Rollback failed during league/join"),
          );
        request.log.error(err, "Failed to join league");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to join league",
        });
      } finally {
        client.release();
      }
    },
  );
}

/**
 * Generate a short, human-friendly referral code. 6 chars from a
 * crockford-ish base32 alphabet (no 0/O/1/I/L to reduce typos). Crypto
 * RNG so codes are not predictable — otherwise an attacker could
 * pre-compute codes and front-run referral attribution.
 */
function generateReferralCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
