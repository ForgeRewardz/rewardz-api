import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  requireWalletAuth,
  requireBearerAuth,
  requireProtocolOwner,
} from "../middleware/auth.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface RegisterBody {
  name: string;
  description?: string;
  blink_base_url?: string;
  supported_actions?: string[];
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
  /* ------ POST /protocols/register ------ */
  app.post(
    "/protocols/register",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RegisterBody | undefined;
      const walletAddress = request.walletAddress!;

      if (!body?.name) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: "name is required" });
      }

      try {
        // Generate a raw API key and store its hash
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
          api_key: rawApiKey,
          name: body.name,
          status: "active",
          created_at: result.rows[0].created_at,
        });
      } catch (err) {
        request.log.error(err, "Failed to register protocol");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to register protocol",
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
}
