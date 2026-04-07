import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireBearerAuth } from "../middleware/auth.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface CreateDelegationBody {
  agent_id: string;
  permissions: object;
  constraints: object;
  expires_at: string;
}

interface DelegationParams {
  id: string;
}

interface PatchDelegationBody {
  status?: string;
  constraints?: object;
}

interface CreateTriggerBody {
  type: string;
  config: object;
}

interface TriggerParams {
  id: string;
  tid: string;
}

interface PatchTriggerBody {
  type?: string;
  config?: object;
  enabled?: boolean;
}

const VALID_DELEGATION_STATUSES = ["active", "paused", "revoked"] as const;

interface DelegationListQuery {
  limit?: string;
  offset?: string;
}

interface PaginationQuery {
  page?: string;
  limit?: string;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function delegationRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /delegations ------ */
  app.post(
    "/delegations",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CreateDelegationBody | undefined;
      const walletAddress = request.walletAddress!;

      if (
        !body?.agent_id ||
        !body.permissions ||
        !body.constraints ||
        !body.expires_at
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message:
            "agent_id, permissions, constraints, and expires_at are required",
        });
      }

      try {
        const result = await query<{
          delegation_id: string;
          created_at: Date;
        }>(
          `INSERT INTO delegations (user_wallet, agent_id, permissions, constraints, expires_at, status)
           VALUES ($1, $2, $3, $4, $5, 'active')
           RETURNING delegation_id, created_at`,
          [
            walletAddress,
            body.agent_id,
            JSON.stringify(body.permissions),
            JSON.stringify(body.constraints),
            body.expires_at,
          ],
        );

        return reply.status(201).send({
          delegation_id: result.rows[0].delegation_id,
          user_wallet: walletAddress,
          agent_id: body.agent_id,
          permissions: body.permissions,
          constraints: body.constraints,
          expires_at: body.expires_at,
          status: "active",
          created_at: result.rows[0].created_at,
        });
      } catch (err) {
        request.log.error(err, "Failed to create delegation");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to create delegation",
        });
      }
    },
  );

  /* ------ GET /delegations ------ */
  app.get(
    "/delegations",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const walletAddress = request.walletAddress!;
      const qs = request.query as DelegationListQuery;

      const limit = Math.min(
        100,
        Math.max(1, parseInt(qs.limit ?? "50", 10) || 50),
      );
      const offset = Math.max(0, parseInt(qs.offset ?? "0", 10) || 0);

      try {
        const result = await query(
          `SELECT delegation_id, user_wallet, agent_id, permissions, constraints, expires_at,
                  status, created_at
           FROM delegations
           WHERE user_wallet = $1 AND status != 'revoked'
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [walletAddress, limit, offset],
        );

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM delegations WHERE user_wallet = $1 AND status != 'revoked'`,
          [walletAddress],
        );
        const total = parseInt(countResult.rows[0].count, 10);

        return reply.status(200).send({
          delegations: result.rows,
          pagination: { limit, offset, total },
        });
      } catch (err) {
        request.log.error(err, "Failed to list delegations");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to list delegations",
        });
      }
    },
  );

  /* ------ GET /delegations/:id ------ */
  app.get(
    "/delegations/:id",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as DelegationParams;
      const walletAddress = request.walletAddress!;

      try {
        const result = await query(
          `SELECT delegation_id, user_wallet, agent_id, permissions, constraints, expires_at,
                  status, created_at
           FROM delegations
           WHERE delegation_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Delegation not found" });
        }

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to fetch delegation");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch delegation",
        });
      }
    },
  );

  /* ------ PATCH /delegations/:id ------ */
  app.patch(
    "/delegations/:id",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as DelegationParams;
      const body = request.body as PatchDelegationBody | undefined;
      const walletAddress = request.walletAddress!;

      if (!body || (!body.status && !body.constraints)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "At least one of status or constraints is required",
        });
      }

      if (
        body.status &&
        !VALID_DELEGATION_STATUSES.includes(
          body.status as (typeof VALID_DELEGATION_STATUSES)[number],
        )
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `status must be one of: ${VALID_DELEGATION_STATUSES.join(", ")}`,
        });
      }

      try {
        // Verify ownership
        const existing = await query<{ delegation_id: string }>(
          `SELECT delegation_id FROM delegations WHERE delegation_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (existing.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Delegation not found" });
        }

        const setClauses: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (body.status) {
          setClauses.push(`status = $${paramIdx++}`);
          params.push(body.status);
        }
        if (body.constraints) {
          setClauses.push(`constraints = $${paramIdx++}`);
          params.push(JSON.stringify(body.constraints));
        }

        params.push(id);

        const result = await query(
          `UPDATE delegations SET ${setClauses.join(", ")} WHERE delegation_id = $${paramIdx}
           RETURNING delegation_id, user_wallet, agent_id, permissions, constraints, expires_at, status, created_at`,
          params,
        );

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to update delegation");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to update delegation",
        });
      }
    },
  );

  /* ------ DELETE /delegations/:id ------ */
  app.delete(
    "/delegations/:id",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as DelegationParams;
      const walletAddress = request.walletAddress!;

      try {
        const result = await query(
          `UPDATE delegations SET status = 'revoked'
           WHERE delegation_id = $1 AND user_wallet = $2
           RETURNING delegation_id`,
          [id, walletAddress],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Delegation not found" });
        }

        return reply.status(200).send({ delegation_id: id, status: "revoked" });
      } catch (err) {
        request.log.error(err, "Failed to revoke delegation");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to revoke delegation",
        });
      }
    },
  );

  /* ------ POST /delegations/:id/triggers ------ */
  app.post(
    "/delegations/:id/triggers",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as DelegationParams;
      const body = request.body as CreateTriggerBody | undefined;
      const walletAddress = request.walletAddress!;

      if (!body?.type || !body.config) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "type and config are required",
        });
      }

      try {
        // Verify delegation ownership
        const delegation = await query<{ delegation_id: string }>(
          `SELECT delegation_id FROM delegations WHERE delegation_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (delegation.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Delegation not found" });
        }

        const result = await query(
          `INSERT INTO delegation_triggers (delegation_id, type, config)
           VALUES ($1, $2, $3)
           RETURNING trigger_id, delegation_id, type, config, enabled`,
          [id, body.type, JSON.stringify(body.config)],
        );

        return reply.status(201).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to create trigger");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to create trigger",
        });
      }
    },
  );

  /* ------ PATCH /delegations/:id/triggers/:tid ------ */
  app.patch(
    "/delegations/:id/triggers/:tid",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, tid } = request.params as TriggerParams;
      const body = request.body as PatchTriggerBody | undefined;
      const walletAddress = request.walletAddress!;

      if (!body || (!body.type && !body.config && body.enabled === undefined)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "At least one of type, config, or enabled is required",
        });
      }

      try {
        // Verify delegation ownership
        const delegation = await query<{ delegation_id: string }>(
          `SELECT delegation_id FROM delegations WHERE delegation_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (delegation.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Delegation not found" });
        }

        const setClauses: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (body.type) {
          setClauses.push(`type = $${paramIdx++}`);
          params.push(body.type);
        }
        if (body.config) {
          setClauses.push(`config = $${paramIdx++}`);
          params.push(JSON.stringify(body.config));
        }
        if (body.enabled !== undefined) {
          setClauses.push(`enabled = $${paramIdx++}`);
          params.push(body.enabled);
        }

        params.push(tid);
        params.push(id);

        const result = await query(
          `UPDATE delegation_triggers
           SET ${setClauses.join(", ")}
           WHERE trigger_id = $${paramIdx++} AND delegation_id = $${paramIdx}
           RETURNING trigger_id, delegation_id, type, config, enabled, last_fired_at, fire_count`,
          params,
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Trigger not found" });
        }

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to update trigger");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to update trigger",
        });
      }
    },
  );

  /* ------ DELETE /delegations/:id/triggers/:tid ------ */
  app.delete(
    "/delegations/:id/triggers/:tid",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, tid } = request.params as TriggerParams;
      const walletAddress = request.walletAddress!;

      try {
        // Verify delegation ownership
        const delegation = await query<{ delegation_id: string }>(
          `SELECT delegation_id FROM delegations WHERE delegation_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (delegation.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Delegation not found" });
        }

        const result = await query(
          `UPDATE delegation_triggers SET enabled = false
           WHERE trigger_id = $1 AND delegation_id = $2
           RETURNING trigger_id`,
          [tid, id],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Trigger not found" });
        }

        return reply.status(200).send({ trigger_id: tid, enabled: false });
      } catch (err) {
        request.log.error(err, "Failed to delete trigger");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to delete trigger",
        });
      }
    },
  );

  /* ------ GET /delegations/:id/audit-log ------ */
  app.get(
    "/delegations/:id/audit-log",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as DelegationParams;
      const qs = request.query as PaginationQuery;
      const walletAddress = request.walletAddress!;

      const page = Math.max(1, parseInt(qs.page ?? "1", 10) || 1);
      const limit = Math.min(
        100,
        Math.max(1, parseInt(qs.limit ?? "20", 10) || 20),
      );
      const offset = (page - 1) * limit;

      try {
        // Verify delegation ownership
        const delegation = await query<{ delegation_id: string }>(
          `SELECT delegation_id FROM delegations WHERE delegation_id = $1 AND user_wallet = $2`,
          [id, walletAddress],
        );

        if (delegation.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Delegation not found" });
        }

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM delegation_audit_log WHERE delegation_id = $1`,
          [id],
        );
        const total = parseInt(countResult.rows[0].count, 10);

        const result = await query(
          `SELECT id, delegation_id, trigger_id, action, tx_signature, result, created_at
           FROM delegation_audit_log
           WHERE delegation_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [id, limit, offset],
        );

        return reply.status(200).send({
          audit_log: result.rows,
          pagination: {
            page,
            limit,
            total,
            total_pages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch audit log");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch audit log",
        });
      }
    },
  );
}
