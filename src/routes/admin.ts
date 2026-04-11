import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAdminAuth, requireBearerAuth } from "../middleware/auth.js";
import { query } from "../db/client.js";
import { takeSnapshot } from "../services/leaderboard-service.js";

/* -------------------------------------------------------------------------- */
/*  Validation schemas                                                        */
/* -------------------------------------------------------------------------- */

const snapshotBodySchema = z.object({
  seasonId: z.string().uuid(),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "Bad Request", message });
}

function notFound(reply: FastifyReply, message: string) {
  return reply.status(404).send({ error: "Not Found", message });
}

function conflict(reply: FastifyReply, message: string) {
  return reply.status(409).send({ error: "Conflict", message });
}

function internalError(reply: FastifyReply, message: string) {
  return reply.status(500).send({ error: "Internal Server Error", message });
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

interface SnapshotBySeasonParams {
  seasonId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /admin/leaderboards/snapshot ------ */
  app.post(
    "/admin/leaderboards/snapshot",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = snapshotBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const { seasonId } = parse.data;

      // Pre-check: is the season already snapshotted? takeSnapshot() is
      // idempotent but we want to surface 409 to clients so they don't
      // silently re-run snapshots.
      const existing = await query<{ snapshot_taken: boolean }>(
        `SELECT snapshot_taken FROM leaderboard_seasons WHERE id = $1 LIMIT 1`,
        [seasonId],
      );
      if (existing.rowCount === 0) {
        return notFound(reply, "Season not found");
      }
      if (existing.rows[0].snapshot_taken) {
        return conflict(reply, "Season already snapshotted");
      }

      try {
        const result = await takeSnapshot(seasonId);
        return reply.status(200).send({
          seasonId,
          protocolsSnapshotted: result.protocolsSnapshotted,
          usersSnapshotted: result.usersSnapshotted,
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err as Error & { code?: string }).code === "SEASON_NOT_FOUND"
        ) {
          return notFound(reply, "Season not found");
        }
        request.log.error(err, "Failed to snapshot leaderboard");
        return internalError(reply, "Failed to snapshot leaderboard");
      }
    },
  );

  /* ------ GET /admin/leaderboards/snapshot/:seasonId ------ */
  app.get<{ Params: SnapshotBySeasonParams }>(
    "/admin/leaderboards/snapshot/:seasonId",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request, reply) => {
      const { seasonId } = request.params;

      if (!seasonId || !UUID_RE.test(seasonId)) {
        return badRequest(reply, "seasonId must be a valid UUID");
      }

      // 404 if the season itself doesn't exist — otherwise we'd silently
      // return an empty snapshot list for a bogus id.
      const seasonCheck = await query<{ id: string }>(
        `SELECT id FROM leaderboard_seasons WHERE id = $1 LIMIT 1`,
        [seasonId],
      );
      if (seasonCheck.rowCount === 0) {
        return notFound(reply, "Season not found");
      }

      try {
        const rows = await query<{
          id: string;
          season_id: string;
          type: string;
          rank: number;
          entity_id: string;
          entity_name: string | null;
          total_points: string;
          snapshot_at: Date;
        }>(
          `SELECT id, season_id, type, rank, entity_id, entity_name,
                  total_points::text AS total_points, snapshot_at
           FROM leaderboard_snapshots
           WHERE season_id = $1
           ORDER BY type, rank`,
          [seasonId],
        );

        const entries = rows.rows.map((row) => ({
          id: row.id,
          seasonId: row.season_id,
          type: row.type,
          rank: row.rank,
          entityId: row.entity_id,
          entityName: row.entity_name,
          totalPoints: BigInt(row.total_points).toString(),
          snapshotAt: row.snapshot_at.toISOString(),
        }));

        return reply.status(200).send({
          seasonId,
          total: entries.length,
          entries,
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch snapshot");
        return internalError(reply, "Failed to fetch snapshot");
      }
    },
  );
}
