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
}
