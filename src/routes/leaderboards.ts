import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getActiveSeason,
  getProtocolLeaderboard,
  getProtocolRank,
  getUserLeaderboard,
  getUserRank,
  type Season,
} from "../services/leaderboard-service.js";

/* -------------------------------------------------------------------------- */
/*  Endpoint paths                                                            */
/* -------------------------------------------------------------------------- */

/*
 * These literals intentionally mirror the `API_LEADERBOARD_*` constants in
 * `@rewardz/types` (sdk/packages/types/src/constants.ts). `@rewardz/types` is
 * NOT a runtime dependency of the api sub-repo yet, so we repeat the literals
 * here. Keep them byte-identical with the sdk — the SDK client in G3 imports
 * from `@rewardz/types` and both sides must agree or requests 404.
 *
 * When adding/renaming: update BOTH this file and `sdk/packages/types/src/
 * constants.ts` in the same PR cycle.
 */
const API_LEADERBOARD_SEASON = "/v1/leaderboard/season" as const;
const API_LEADERBOARD_PROTOCOLS = "/v1/leaderboard/protocols" as const;
const API_LEADERBOARD_PROTOCOLS_BY_ID = "/v1/leaderboard/protocols/:id" as const;
const API_LEADERBOARD_USERS = "/v1/leaderboard/users" as const;
const API_LEADERBOARD_USER_BY_WALLET = "/v1/leaderboard/users/:wallet" as const;

/* -------------------------------------------------------------------------- */
/*  Request types                                                             */
/* -------------------------------------------------------------------------- */

interface LeaderboardQuery {
  seasonId?: string;
  limit?: string;
  page?: string;
  offset?: string;
}

interface ProtocolByIdParams {
  id: string;
}

interface UserByWalletParams {
  wallet: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Wire-format `Season` — ISO-8601 timestamps, not native `Date`. Mirrors
 * `@rewardz/types` `Season`; status derives from `is_active` + timestamp
 * comparisons at request time.
 */
interface WireSeason {
  seasonId: string;
  name: string;
  description: string | null;
  startAt: string;
  endAt: string | null;
  status: "upcoming" | "active" | "completed";
  snapshotTaken: boolean;
}

function serialiseSeason(season: Season): WireSeason {
  const now = Date.now();
  const startMs = season.startAt.getTime();
  const endMs = season.endAt?.getTime();

  let status: "upcoming" | "active" | "completed";
  if (startMs > now) {
    status = "upcoming";
  } else if (endMs !== undefined && endMs <= now) {
    status = "completed";
  } else if (season.isActive) {
    status = "active";
  } else {
    status = "completed";
  }

  return {
    seasonId: season.id,
    name: season.name,
    description: season.description,
    startAt: season.startAt.toISOString(),
    endAt: season.endAt ? season.endAt.toISOString() : null,
    status,
    snapshotTaken: season.snapshotTaken,
  };
}

/**
 * Parse pagination query params — accepts either `?page=1` (1-indexed) or
 * `?offset=0` (0-indexed). `limit` is clamped to `[1, MAX_LIMIT]`.
 */
function parsePagination(qs: LeaderboardQuery): { limit: number; offset: number } {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(qs.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );

  if (qs.offset !== undefined) {
    const offset = Math.max(0, parseInt(qs.offset, 10) || 0);
    return { limit, offset };
  }

  const page = Math.max(1, parseInt(qs.page ?? "1", 10) || 1);
  return { limit, offset: (page - 1) * limit };
}

/**
 * Resolve the caller's target season: use `?seasonId=<uuid>` if provided,
 * otherwise fall back to the currently-active season. Returns `null` if
 * neither is available so routes can reply 404 consistently.
 */
async function resolveSeasonId(qs: LeaderboardQuery): Promise<string | null> {
  if (qs.seasonId) return qs.seasonId;
  const active = await getActiveSeason();
  return active?.id ?? null;
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "Bad Request", message });
}

function notFound(reply: FastifyReply, message: string) {
  return reply.status(404).send({ error: "Not Found", message });
}

function internalError(reply: FastifyReply, message: string) {
  return reply.status(500).send({ error: "Internal Server Error", message });
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  /* ------ GET /leaderboard/season ------ */
  app.get(
    API_LEADERBOARD_SEASON.replace("/v1", ""),
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const active = await getActiveSeason();
        if (!active) {
          return notFound(reply, "No active season");
        }
        return reply.status(200).send(serialiseSeason(active));
      } catch (err) {
        _request.log.error(err, "Failed to fetch active season");
        return internalError(reply, "Failed to fetch active season");
      }
    },
  );

  /* ------ GET /leaderboard/protocols ------ */
  app.get(
    API_LEADERBOARD_PROTOCOLS.replace("/v1", ""),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as LeaderboardQuery;

      try {
        const seasonId = await resolveSeasonId(qs);
        if (!seasonId) {
          return notFound(reply, "No active season");
        }

        const { limit, offset } = parsePagination(qs);
        const { entries, total } = await getProtocolLeaderboard(
          seasonId,
          limit,
          offset,
        );

        return reply.status(200).send({ entries, total, seasonId });
      } catch (err) {
        request.log.error(err, "Failed to fetch protocol leaderboard");
        return internalError(reply, "Failed to fetch protocol leaderboard");
      }
    },
  );

  /* ------ GET /leaderboard/protocols/:id ------ */
  app.get(
    API_LEADERBOARD_PROTOCOLS_BY_ID.replace("/v1", ""),
    async (
      request: FastifyRequest<{
        Params: ProtocolByIdParams;
        Querystring: LeaderboardQuery;
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      if (!id) {
        return badRequest(reply, "protocol id path parameter is required");
      }

      try {
        const seasonId = await resolveSeasonId(request.query);
        if (!seasonId) {
          return notFound(reply, "No active season");
        }

        const rank = await getProtocolRank(id, seasonId);
        if (!rank) {
          return notFound(reply, "Protocol has no score for this season");
        }

        return reply.status(200).send(rank);
      } catch (err) {
        request.log.error(err, "Failed to fetch protocol rank");
        return internalError(reply, "Failed to fetch protocol rank");
      }
    },
  );

  /* ------ GET /leaderboard/users ------ */
  app.get(
    API_LEADERBOARD_USERS.replace("/v1", ""),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as LeaderboardQuery;

      try {
        const seasonId = await resolveSeasonId(qs);
        if (!seasonId) {
          return notFound(reply, "No active season");
        }

        const { limit, offset } = parsePagination(qs);
        const { entries, total } = await getUserLeaderboard(
          seasonId,
          limit,
          offset,
        );

        return reply.status(200).send({ entries, total, seasonId });
      } catch (err) {
        request.log.error(err, "Failed to fetch user leaderboard");
        return internalError(reply, "Failed to fetch user leaderboard");
      }
    },
  );

  /* ------ GET /leaderboard/users/:wallet ------ */
  app.get(
    API_LEADERBOARD_USER_BY_WALLET.replace("/v1", ""),
    async (
      request: FastifyRequest<{
        Params: UserByWalletParams;
        Querystring: LeaderboardQuery;
      }>,
      reply: FastifyReply,
    ) => {
      const { wallet } = request.params;
      if (!wallet) {
        return badRequest(reply, "wallet path parameter is required");
      }

      try {
        const seasonId = await resolveSeasonId(request.query);
        if (!seasonId) {
          return notFound(reply, "No active season");
        }

        const rank = await getUserRank(wallet, seasonId);
        if (!rank) {
          return notFound(reply, "Wallet has no score for this season");
        }

        return reply.status(200).send(rank);
      } catch (err) {
        request.log.error(err, "Failed to fetch user rank");
        return internalError(reply, "Failed to fetch user rank");
      }
    },
  );
}
