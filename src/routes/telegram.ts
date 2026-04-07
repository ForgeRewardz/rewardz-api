import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireInternalKey, requireWalletAuth } from "../middleware/auth.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface CreateUserBody {
  telegram_id: string;
  wallet_address: string;
  username?: string;
}

interface TelegramUserParams {
  telegram_id: string;
}

interface StreakParams {
  id: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function getMultiplierTier(streak: number): {
  tier: string;
  multiplier: number;
} {
  if (streak >= 30) return { tier: "diamond", multiplier: 2.0 };
  if (streak >= 14) return { tier: "gold", multiplier: 1.5 };
  if (streak >= 7) return { tier: "silver", multiplier: 1.25 };
  if (streak >= 3) return { tier: "bronze", multiplier: 1.1 };
  return { tier: "none", multiplier: 1.0 };
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function telegramRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /telegram/users ------ */
  app.post(
    "/telegram/users",
    { preHandler: [requireInternalKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CreateUserBody | undefined;

      if (!body?.telegram_id || !body.wallet_address) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "telegram_id and wallet_address are required",
        });
      }

      try {
        const result = await query(
          `INSERT INTO telegram_users (telegram_id, wallet_address, username)
           VALUES ($1, $2, $3)
           ON CONFLICT (telegram_id)
           DO UPDATE SET wallet_address = EXCLUDED.wallet_address,
                         username = COALESCE(EXCLUDED.username, telegram_users.username),
                         updated_at = NOW()
           RETURNING telegram_id, wallet_address, username, created_at, updated_at`,
          [body.telegram_id, body.wallet_address, body.username ?? null],
        );

        return reply.status(201).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to upsert telegram user");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to upsert telegram user",
        });
      }
    },
  );

  /* ------ GET /telegram/users/:telegram_id ------ */
  app.get(
    "/telegram/users/:telegram_id",
    { preHandler: [requireInternalKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { telegram_id } = request.params as TelegramUserParams;

      try {
        const result = await query(
          `SELECT telegram_id, wallet_address, username, created_at, updated_at
           FROM telegram_users
           WHERE telegram_id = $1`,
          [telegram_id],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Telegram user not found" });
        }

        return reply.status(200).send(result.rows[0]);
      } catch (err) {
        request.log.error(err, "Failed to fetch telegram user");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch telegram user",
        });
      }
    },
  );

  /* ------ GET /subscriptions/:id/streak ------ */
  app.get(
    "/subscriptions/:id/streak",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as StreakParams;

      try {
        const result = await query<{
          subscription_id: string;
          streak_current: string;
          streak_longest: string;
          last_executed_at: Date | null;
        }>(
          `SELECT subscription_id, streak_current, streak_longest, last_executed_at
           FROM subscriptions
           WHERE subscription_id = $1`,
          [id],
        );

        if (result.rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Subscription not found" });
        }

        const sub = result.rows[0];
        const currentStreak = parseInt(sub.streak_current, 10);
        const longestStreak = parseInt(sub.streak_longest, 10);
        const { tier, multiplier } = getMultiplierTier(currentStreak);

        return reply.status(200).send({
          subscription_id: sub.subscription_id,
          current_streak: currentStreak,
          longest_streak: longestStreak,
          last_executed_at: sub.last_executed_at,
          multiplier_tier: tier,
          multiplier,
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch streak");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch streak",
        });
      }
    },
  );
}
