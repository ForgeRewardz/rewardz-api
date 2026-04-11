import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireWalletAuth, requireApiKey } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  awardPoints,
  getBalance,
  getHistory,
  batchAward,
} from "../services/points-service.js";

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface BalanceQuery {
  wallet: string;
}

interface HistoryQuery {
  wallet: string;
  limit?: string;
  offset?: string;
}

interface AwardBody {
  wallet_address: string;
  amount: number;
  reason: string;
  idempotency_key: string;
}

interface BatchAwardBody {
  awards: Array<{
    wallet_address: string;
    amount: number;
    idempotency_key: string;
    reason?: string;
  }>;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Serialize BigInt values to string for JSON output */
function serializeBalance(bal: Awaited<ReturnType<typeof getBalance>>) {
  if (!bal) return null;
  return {
    wallet_address: bal.wallet_address,
    total_earned: bal.total_earned.toString(),
    total_pending: bal.total_pending.toString(),
    total_spent: bal.total_spent.toString(),
    total_reserved: bal.total_reserved.toString(),
    usable_balance: bal.usable_balance.toString(),
    updated_at: bal.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function pointRoutes(app: FastifyInstance): Promise<void> {
  /* ------ GET /points/balance ------ */
  app.get(
    "/points/balance",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { wallet } = request.query as BalanceQuery;

      if (!wallet) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message: "wallet query parameter is required",
          });
      }

      try {
        const balance = await getBalance(wallet);

        if (!balance) {
          return reply.status(200).send({
            wallet_address: wallet,
            total_earned: "0",
            total_pending: "0",
            total_spent: "0",
            total_reserved: "0",
            usable_balance: "0",
            updated_at: null,
          });
        }

        return reply.status(200).send(serializeBalance(balance));
      } catch (err) {
        request.log.error(err, "Failed to fetch balance");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch balance",
          });
      }
    },
  );

  /* ------ GET /points/history ------ */
  app.get(
    "/points/history",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as HistoryQuery;

      if (!qs.wallet) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message: "wallet query parameter is required",
          });
      }

      const limit = Math.min(
        100,
        Math.max(1, parseInt(qs.limit ?? "20", 10) || 20),
      );
      const offset = Math.max(0, parseInt(qs.offset ?? "0", 10) || 0);

      try {
        const events = await getHistory(qs.wallet, limit, offset);

        // Serialize BigInt amounts
        const serialized = events.map((e) => ({
          ...e,
          amount: e.amount.toString(),
        }));

        return reply.status(200).send({ events: serialized });
      } catch (err) {
        request.log.error(err, "Failed to fetch history");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to fetch history",
          });
      }
    },
  );

  /* ------ POST /points/award ------ */
  app.post(
    "/points/award",
    { preHandler: [requireApiKey, rateLimit()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as AwardBody | undefined;

      if (
        !body?.wallet_address ||
        body.amount == null ||
        !body.reason ||
        !body.idempotency_key
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message:
            "wallet_address, amount, reason, and idempotency_key are required",
        });
      }

      if (body.amount <= 0) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: "amount must be positive" });
      }

      try {
        const result = await awardPoints(
          body.wallet_address,
          BigInt(body.amount),
          request.protocolId ?? null,
          { type: "reference", key: body.idempotency_key },
          body.reason,
          "api",
        );

        return reply.status(200).send({
          success: result.success,
          event_id: result.event_id,
          new_balance: result.new_balance?.toString(),
          duplicate: result.duplicate ?? false,
        });
      } catch (err) {
        request.log.error(err, "Failed to award points");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to award points",
          });
      }
    },
  );

  /* ------ POST /points/award/batch ------ */
  app.post(
    "/points/award/batch",
    { preHandler: [requireApiKey, rateLimit()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as BatchAwardBody | undefined;

      if (!body?.awards || !Array.isArray(body.awards)) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: "awards array is required" });
      }

      if (body.awards.length > 100) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message: "Maximum 100 awards per batch",
          });
      }

      // Validate each award item
      for (const award of body.awards) {
        if (
          !award.wallet_address ||
          award.amount == null ||
          !award.idempotency_key
        ) {
          return reply.status(400).send({
            error: "Bad Request",
            message:
              "Each award must have wallet_address, amount, and idempotency_key",
          });
        }
        if (award.amount <= 0) {
          return reply
            .status(400)
            .send({
              error: "Bad Request",
              message: "All amounts must be positive",
            });
        }
      }

      try {
        const items = body.awards.map((a) => ({
          wallet: a.wallet_address,
          amount: BigInt(a.amount),
          protocolId: request.protocolId ?? "",
          idempotencyKey: a.idempotency_key,
          reason: a.reason,
          channel: "api" as const,
        }));

        const result = await batchAward(items);

        // Serialize BigInt values
        const serializedResults = result.results.map((r) => ({
          ...r,
          new_balance: r.new_balance?.toString(),
        }));

        return reply.status(200).send({
          total: result.total,
          succeeded: result.succeeded,
          duplicates: result.duplicates,
          failed: result.failed,
          results: serializedResults,
        });
      } catch (err) {
        request.log.error(err, "Failed to batch award points");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Failed to batch award points",
          });
      }
    },
  );
}
