import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireWalletAuth } from "../middleware/auth.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface CreateSubscriptionBody {
  quest_id?: string;
  action_type: string;
  intent_query?: string;
  params: object;
  frequency: "daily" | "weekly" | "monthly";
  preferred_day?: number;
  preferred_hour?: number;
  auto_execute?: boolean;
}

interface SubscriptionParams {
  id: string;
}

interface ListQuery {
  wallet: string;
}

interface PatchBody {
  status?: string;
  params?: object;
  frequency?: "daily" | "weekly" | "monthly";
}

const VALID_SUBSCRIPTION_STATUSES = ["active", "paused", "cancelled"] as const;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function calculateNextDueAt(
  frequency: string,
  preferredDay?: number,
  preferredHour?: number,
): Date {
  const now = new Date();
  const next = new Date(now);

  const hour = preferredHour ?? 9; // default 9 AM UTC

  switch (frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(hour, 0, 0, 0);
      break;
    case "weekly": {
      const day = preferredDay ?? 1; // default Monday
      const currentDay = next.getUTCDay();
      const daysUntil = (day - currentDay + 7) % 7 || 7;
      next.setUTCDate(next.getUTCDate() + daysUntil);
      next.setUTCHours(hour, 0, 0, 0);
      break;
    }
    case "monthly": {
      const targetDay = preferredDay ?? 1;
      next.setUTCMonth(next.getUTCMonth() + 1);
      next.setUTCDate(Math.min(targetDay, 28)); // safe for all months
      next.setUTCHours(hour, 0, 0, 0);
      break;
    }
    default:
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(hour, 0, 0, 0);
  }

  return next;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /subscriptions ------ */
  app.post(
    "/subscriptions",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CreateSubscriptionBody | undefined;
      const walletAddress = request.walletAddress!;

      if (!body?.action_type || !body.params || !body.frequency) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "action_type, params, and frequency are required",
        });
      }

      const validFrequencies = ["daily", "weekly", "monthly"];
      if (!validFrequencies.includes(body.frequency)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "frequency must be one of: daily, weekly, monthly",
        });
      }

      try {
        const nextDueAt = calculateNextDueAt(
          body.frequency,
          body.preferred_day,
          body.preferred_hour,
        );

        const result = await query<{
          subscription_id: string;
          created_at: Date;
        }>(
          `INSERT INTO subscriptions (
             wallet_address, quest_id, action_type, intent_query, params,
             frequency, preferred_day, preferred_hour, auto_execute,
             next_due_at, status
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
           RETURNING subscription_id, created_at`,
          [
            walletAddress,
            body.quest_id ?? null,
            body.action_type,
            body.intent_query ?? null,
            JSON.stringify(body.params),
            body.frequency,
            body.preferred_day ?? null,
            body.preferred_hour ?? null,
            body.auto_execute ?? false,
            nextDueAt,
          ],
        );

        return reply.status(201).send({
          subscription_id: result.rows[0].subscription_id,
          wallet_address: walletAddress,
          action_type: body.action_type,
          frequency: body.frequency,
          next_due_at: nextDueAt.toISOString(),
          status: "active",
          created_at: result.rows[0].created_at,
        });
      } catch (err) {
        request.log.error(err, "Failed to create subscription");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to create subscription",
        });
      }
    },
  );

  /* ------ GET /subscriptions ------ */
  app.get(
    "/subscriptions",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { wallet } = request.query as ListQuery;

      if (!wallet) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "wallet query parameter is required",
        });
      }

      try {
        const result = await query(
          `SELECT subscription_id, wallet_address, quest_id, action_type, intent_query, params,
                  frequency, preferred_day, preferred_hour, auto_execute,
                  next_due_at, streak_current, streak_longest, last_executed_at,
                  status, created_at, updated_at
           FROM subscriptions
           WHERE wallet_address = $1
           ORDER BY created_at DESC`,
          [wallet],
        );

        return reply.status(200).send({ subscriptions: result.rows });
      } catch (err) {
        request.log.error(err, "Failed to list subscriptions");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to list subscriptions",
        });
      }
    },
  );

  /* ------ GET /subscriptions/:id ------ */
  app.get(
    "/subscriptions/:id",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as SubscriptionParams;

      try {
        const result = await query(
          `SELECT subscription_id, wallet_address, quest_id, action_type, intent_query, params,
                  frequency, preferred_day, preferred_hour, auto_execute,
                  next_due_at, streak_current, streak_longest, last_executed_at,
                  status, created_at, updated_at
           FROM subscriptions
           WHERE subscription_id = $1`,
          [id],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Subscription not found" });
        }

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to fetch subscription");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch subscription",
        });
      }
    },
  );

  /* ------ PATCH /subscriptions/:id ------ */
  app.patch(
    "/subscriptions/:id",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as SubscriptionParams;
      const body = request.body as PatchBody | undefined;
      const walletAddress = request.walletAddress!;

      if (!body || (!body.status && !body.params && !body.frequency)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "At least one of status, params, or frequency is required",
        });
      }

      if (
        body.status &&
        !VALID_SUBSCRIPTION_STATUSES.includes(
          body.status as (typeof VALID_SUBSCRIPTION_STATUSES)[number],
        )
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `status must be one of: ${VALID_SUBSCRIPTION_STATUSES.join(", ")}`,
        });
      }

      try {
        // Verify ownership
        const existing = await query<{ subscription_id: string }>(
          `SELECT subscription_id FROM subscriptions WHERE subscription_id = $1 AND wallet_address = $2`,
          [id, walletAddress],
        );

        if (existing.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Subscription not found" });
        }

        const setClauses: string[] = ["updated_at = NOW()"];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (body.status) {
          setClauses.push(`status = $${paramIdx++}`);
          params.push(body.status);
        }
        if (body.params) {
          setClauses.push(`params = $${paramIdx++}`);
          params.push(JSON.stringify(body.params));
        }
        if (body.frequency) {
          setClauses.push(`frequency = $${paramIdx++}`);
          params.push(body.frequency);

          // Recalculate next_due_at when frequency changes
          const nextDueAt = calculateNextDueAt(body.frequency);
          setClauses.push(`next_due_at = $${paramIdx++}`);
          params.push(nextDueAt);
        }

        params.push(id);

        const result = await query(
          `UPDATE subscriptions SET ${setClauses.join(", ")} WHERE subscription_id = $${paramIdx}
           RETURNING subscription_id, wallet_address, quest_id, action_type, intent_query, params,
                     frequency, preferred_day, preferred_hour, auto_execute,
                     next_due_at, streak_current, streak_longest, last_executed_at,
                     status, created_at, updated_at`,
          params,
        );

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to update subscription");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to update subscription",
        });
      }
    },
  );
}
