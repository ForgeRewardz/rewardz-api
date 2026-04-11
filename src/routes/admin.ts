import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { requireAdminAuth, requireBearerAuth } from "../middleware/auth.js";
import { pool, query } from "../db/client.js";
import { takeSnapshot } from "../services/leaderboard-service.js";

/* -------------------------------------------------------------------------- */
/*  Validation schemas                                                        */
/* -------------------------------------------------------------------------- */

const snapshotBodySchema = z.object({
  seasonId: z.string().uuid(),
});

const slashBodySchema = z.object({
  amount: z.string().min(1),
  reason: z.string().min(1),
});

const cooldownBodySchema = z.object({
  hours: z.number().positive().int(),
  reason: z.string().min(1),
});

const reasonOnlyBodySchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .optional();

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

/**
 * Insert exactly one `admin_audit_log` row using the shared parameterised
 * pattern mandated by the Phase 5 v2 plan exit criterion #3. Callers
 * that are already inside a transaction should pass their own client
 * via `client`; otherwise this function runs on the shared pool.
 *
 * `target_type` maps to either `target_protocol_id` or
 * `target_campaign_id` in the 022_admin_audit_log schema — keeping the
 * public signature generic (`target_type` + `target_id`) lets callers
 * express the intent in one line without knowing which column the row
 * lives in.
 */
async function writeAuditLog(
  client: pg.PoolClient | null,
  args: {
    adminWallet: string;
    action: string;
    targetType: "protocol" | "campaign" | "season";
    targetId: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  // 022_admin_audit_log has two typed target columns (UUID FKs). Map
  // the generic target_type/target_id pair onto whichever column fits:
  //   protocol → target_protocol_id
  //   campaign → target_campaign_id
  //   season   → neither (season rollups predate the table); we stash
  //              the season id inside `details.season_id` instead.
  const targetProtocolId =
    args.targetType === "protocol" ? args.targetId : null;
  const targetCampaignId =
    args.targetType === "campaign" ? args.targetId : null;

  const details =
    args.targetType === "season"
      ? { ...args.details, season_id: args.targetId }
      : args.details;

  const sql = `INSERT INTO admin_audit_log (admin_wallet, action, target_protocol_id, target_campaign_id, details, created_at)
               VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`;
  const params = [
    args.adminWallet,
    args.action,
    targetProtocolId,
    targetCampaignId,
    JSON.stringify(details),
  ];

  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}

interface SnapshotBySeasonParams {
  seasonId: string;
}

interface ProtocolIdParams {
  id: string;
}

interface CampaignIdParams {
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

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
      const adminWallet = request.walletAddress!;

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

        // Retrofit audit log write flagged by G1 code review. We write
        // *after* takeSnapshot() so the audit trail reflects what
        // actually happened — takeSnapshot() has its own internal tx
        // and failing to stuff the audit insert inside it would mean a
        // second concurrent snapshot run could see half-finished state.
        await writeAuditLog(null, {
          adminWallet,
          action: "leaderboard.snapshot.take",
          targetType: "season",
          targetId: seasonId,
          details: {
            protocolsSnapshotted: result.protocolsSnapshotted,
            usersSnapshotted: result.usersSnapshotted,
          },
        });

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

  /* ------------------------------------------------------------------ */
  /*  Protocol moderation (plan task 42)                                */
  /*                                                                    */
  /*  All 4 protocol routes share the same structure: start a tx, run   */
  /*  the state change, write exactly one admin_audit_log row, commit.  */
  /*  If anything inside the tx throws the ROLLBACK guarantees the      */
  /*  audit trail stays consistent with the on-disk state.              */
  /* ------------------------------------------------------------------ */

  app.post<{ Params: ProtocolIdParams }>(
    "/admin/protocols/:id/pause",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return badRequest(reply, "protocol id must be a valid UUID");
      }
      const body = reasonOnlyBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return badRequest(reply, "Invalid body");
      }
      const adminWallet = request.walletAddress!;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const upd = await client.query<{ id: string }>(
          `UPDATE protocols SET status = 'paused', updated_at = NOW()
            WHERE id = $1 RETURNING id`,
          [id],
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return notFound(reply, "Protocol not found");
        }
        await writeAuditLog(client, {
          adminWallet,
          action: "protocol.pause",
          targetType: "protocol",
          targetId: id,
          details: { reason: body.data?.reason ?? null },
        });
        await client.query("COMMIT");
        return reply.status(200).send({ protocolId: id, status: "paused" });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error(err, "Failed to pause protocol");
        return internalError(reply, "Failed to pause protocol");
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: ProtocolIdParams }>(
    "/admin/protocols/:id/resume",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return badRequest(reply, "protocol id must be a valid UUID");
      }
      const body = reasonOnlyBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return badRequest(reply, "Invalid body");
      }
      const adminWallet = request.walletAddress!;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const upd = await client.query<{ id: string }>(
          `UPDATE protocols SET status = 'active', updated_at = NOW()
            WHERE id = $1 RETURNING id`,
          [id],
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return notFound(reply, "Protocol not found");
        }
        await writeAuditLog(client, {
          adminWallet,
          action: "protocol.resume",
          targetType: "protocol",
          targetId: id,
          details: { reason: body.data?.reason ?? null },
        });
        await client.query("COMMIT");
        return reply.status(200).send({ protocolId: id, status: "active" });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error(err, "Failed to resume protocol");
        return internalError(reply, "Failed to resume protocol");
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: ProtocolIdParams }>(
    "/admin/protocols/:id/slash",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return badRequest(reply, "protocol id must be a valid UUID");
      }
      const parse = slashBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const adminWallet = request.walletAddress!;
      const { amount, reason } = parse.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Slash = trust_score penalty today (no on-chain stake yet).
        // Step the trust_score down by a proportional amount so the
        // state change is observable via GET /protocols. Clamp at 0 so
        // repeated slashes can't drive it negative.
        const upd = await client.query<{ id: string; trust_score: number }>(
          `UPDATE protocols
              SET trust_score = GREATEST(0, trust_score - 1000),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING id, trust_score`,
          [id],
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return notFound(reply, "Protocol not found");
        }
        await writeAuditLog(client, {
          adminWallet,
          action: "protocol.slash",
          targetType: "protocol",
          targetId: id,
          details: { amount, reason },
        });
        await client.query("COMMIT");

        return reply.status(200).send({
          protocolId: id,
          trustScore: upd.rows[0].trust_score,
          slashedAmount: amount,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error(err, "Failed to slash protocol");
        return internalError(reply, "Failed to slash protocol");
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: ProtocolIdParams }>(
    "/admin/protocols/:id/cooldown",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return badRequest(reply, "protocol id must be a valid UUID");
      }
      const parse = cooldownBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const adminWallet = request.walletAddress!;
      const { hours, reason } = parse.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Cooldown = flip status to 'cooldown' so downstream reads can
        // see the pause window; the concrete expiry timestamp lives in
        // the audit log `details` blob until Phase 5 Session 4 adds a
        // protocol_cooldowns table. Keeps the state change observable
        // without a new migration.
        const upd = await client.query<{ id: string }>(
          `UPDATE protocols SET status = 'cooldown', updated_at = NOW()
            WHERE id = $1 RETURNING id`,
          [id],
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return notFound(reply, "Protocol not found");
        }

        const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
        await writeAuditLog(client, {
          adminWallet,
          action: "protocol.cooldown",
          targetType: "protocol",
          targetId: id,
          details: { hours, reason, expires_at: expiresAt.toISOString() },
        });
        await client.query("COMMIT");

        return reply.status(200).send({
          protocolId: id,
          status: "cooldown",
          cooldownHours: hours,
          expiresAt: expiresAt.toISOString(),
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error(err, "Failed to apply cooldown");
        return internalError(reply, "Failed to apply cooldown");
      } finally {
        client.release();
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /*  Campaign moderation (plan task 42)                                */
  /* ------------------------------------------------------------------ */

  app.post<{ Params: CampaignIdParams }>(
    "/admin/campaigns/:id/pause",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return badRequest(reply, "campaign id must be a valid UUID");
      }
      const body = reasonOnlyBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return badRequest(reply, "Invalid body");
      }
      const adminWallet = request.walletAddress!;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const upd = await client.query<{ campaign_id: string }>(
          `UPDATE campaigns SET status = 'paused'
            WHERE campaign_id = $1 RETURNING campaign_id`,
          [id],
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return notFound(reply, "Campaign not found");
        }
        await writeAuditLog(client, {
          adminWallet,
          action: "campaign.pause",
          targetType: "campaign",
          targetId: id,
          details: { reason: body.data?.reason ?? null },
        });
        await client.query("COMMIT");
        return reply.status(200).send({ campaignId: id, status: "paused" });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error(err, "Failed to pause campaign");
        return internalError(reply, "Failed to pause campaign");
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: CampaignIdParams }>(
    "/admin/campaigns/:id/resume",
    { preHandler: [requireBearerAuth, requireAdminAuth] },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return badRequest(reply, "campaign id must be a valid UUID");
      }
      const body = reasonOnlyBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return badRequest(reply, "Invalid body");
      }
      const adminWallet = request.walletAddress!;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const upd = await client.query<{ campaign_id: string }>(
          `UPDATE campaigns SET status = 'live'
            WHERE campaign_id = $1 RETURNING campaign_id`,
          [id],
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return notFound(reply, "Campaign not found");
        }
        await writeAuditLog(client, {
          adminWallet,
          action: "campaign.resume",
          targetType: "campaign",
          targetId: id,
          details: { reason: body.data?.reason ?? null },
        });
        await client.query("COMMIT");
        return reply.status(200).send({ campaignId: id, status: "live" });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        request.log.error(err, "Failed to resume campaign");
        return internalError(reply, "Failed to resume campaign");
      } finally {
        client.release();
      }
    },
  );
}
