import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rateLimit } from "../middleware/rate-limit.js";
import { gameEvents } from "../services/game-event-listener.js";
import {
  getCurrentRound,
  getRoundHistory,
  getRoundPlayers,
  getRoundResults,
  getRoundStatus,
  type ParsedGameEvent,
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

  // §4.3 / §10.2 — redacted joiner stream.
  //
  // Server-Sent-Events feed of `PlayerDeployed` events. We DO NOT expose the
  // full wallet, the points deployed, or the fee — this is the public
  // "player X just joined" ticker that backs the mobile mini-app's social
  // proof block. Only wallet suffix (3+2 chars) and timestamp leak.
  //
  // The emitter (`gameEvents`) is populated by `startGameEventListener`;
  // we subscribe per-connection and detach on `close`/`aborted` so we
  // never leak listeners. A 20s `:ping\n\n` keepalive prevents
  // intermediaries (Nginx, Railway proxy) from killing idle connections.
  app.get(
    "/game/round/joiners",
    { preHandler: [rateLimit(60_000, 120)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { roundId: filterRoundId } = request.query as {
        roundId?: string;
      };

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Flush buffers with an immediate comment frame so clients know the
      // handshake is open (important on CDNs that buffer until first byte).
      reply.raw.write(":ready\n\n");

      const listener = (event: ParsedGameEvent, _sig: string): void => {
        if (event.eventName !== "PlayerDeployed") return;
        if (filterRoundId && event.roundId !== filterRoundId) return;
        const wallet = event.walletAddress;
        if (!wallet || wallet.length < 6) return;
        const walletSuffix = `${wallet.slice(0, 3)}…${wallet.slice(-2)}`;
        // Redacted payload — roundId, walletSuffix, timestamp. Nothing
        // else. Never include points, fee, full wallet, email, or any
        // other field from the source event.
        const payload = JSON.stringify({
          roundId: event.roundId,
          walletSuffix,
          t: new Date().toISOString(),
        });
        reply.raw.write(`event: joined\ndata: ${payload}\n\n`);
      };
      gameEvents.on("event", listener);

      const keepalive = setInterval(() => {
        reply.raw.write(":ping\n\n");
      }, 20_000);

      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(keepalive);
        gameEvents.off("event", listener);
      };
      request.raw.on("close", cleanup);
      request.raw.on("aborted", cleanup);

      // Hijack the reply — Fastify must not auto-send a body or close the
      // stream. Returning the raw reply signals we've taken control.
      return reply;
    },
  );
}
