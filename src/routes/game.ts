import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  getCurrentRound,
  getRoundHistory,
  getRoundPlayers,
  getRoundResults,
  getRoundStatus,
} from "../services/game-service.js";

interface WalletQuery {
  wallet?: string;
}

interface HistoryQuery {
  limit?: string;
  offset?: string;
}

interface RoundParams {
  id: string;
}

function parseLimitOffset(qs: HistoryQuery): { limit: number; offset: number } {
  const limit = Math.min(
    100,
    Math.max(1, parseInt(qs.limit ?? "20", 10) || 20),
  );
  const offset = Math.max(0, parseInt(qs.offset ?? "0", 10) || 0);
  return { limit, offset };
}

function invalidRoundId(reply: FastifyReply) {
  return reply.status(400).send({
    error: "Bad Request",
    message: "round id must be a positive integer",
  });
}

function parseRoundId(raw: string): string | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  return raw;
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    error: "Not Found",
    message: "round not found",
  });
}

function internalError(reply: FastifyReply, message: string) {
  return reply.status(500).send({
    error: "Internal Server Error",
    message,
  });
}

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/game/round/current",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { wallet } = request.query as WalletQuery;
      try {
        return reply.status(200).send(await getCurrentRound(wallet));
      } catch (err) {
        request.log.error(err, "Failed to fetch current game round");
        return internalError(reply, "Failed to fetch current game round");
      }
    },
  );

  app.get(
    "/game/round/history",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { limit, offset } = parseLimitOffset(request.query as HistoryQuery);
      try {
        return reply.status(200).send(await getRoundHistory(limit, offset));
      } catch (err) {
        request.log.error(err, "Failed to fetch game round history");
        return internalError(reply, "Failed to fetch game round history");
      }
    },
  );

  app.get(
    "/game/round/:id/status",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as RoundParams;
      const roundId = parseRoundId(id);
      if (!roundId) return invalidRoundId(reply);
      const { wallet } = request.query as WalletQuery;
      try {
        const result = await getRoundStatus(roundId, wallet);
        return result ? reply.status(200).send(result) : notFound(reply);
      } catch (err) {
        request.log.error(err, "Failed to fetch game round status");
        return internalError(reply, "Failed to fetch game round status");
      }
    },
  );

  app.get(
    "/game/round/:id/players",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as RoundParams;
      const roundId = parseRoundId(id);
      if (!roundId) return invalidRoundId(reply);
      const { wallet } = request.query as WalletQuery;
      try {
        const result = await getRoundPlayers(roundId, wallet);
        return result ? reply.status(200).send(result) : notFound(reply);
      } catch (err) {
        request.log.error(err, "Failed to fetch game round players");
        return internalError(reply, "Failed to fetch game round players");
      }
    },
  );

  app.get(
    "/game/round/:id/results",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as RoundParams;
      const roundId = parseRoundId(id);
      if (!roundId) return invalidRoundId(reply);
      const { wallet } = request.query as WalletQuery;
      try {
        const result = await getRoundResults(roundId, wallet);
        return result ? reply.status(200).send(result) : notFound(reply);
      } catch (err) {
        request.log.error(err, "Failed to fetch game round results");
        return internalError(reply, "Failed to fetch game round results");
      }
    },
  );
}
