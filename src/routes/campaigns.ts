/**
 * Campaign CRUD routes under `/v1/protocols/:id/campaigns`.
 *
 * Covers Phase 5 Session 3 plan task 40. All routes are protected by
 * `requireBearerAuth + requireProtocolOwner` — H1 already applied this
 * same pattern to the existing `/v1/protocols/:id/*` routes in
 * `routes/protocols.ts`, so we mirror it per-route instead of wiring a
 * parent-scope hook. A parent hook would double-gate the existing
 * routes in `protocols.ts`.
 *
 * Schema note: campaigns is the 005_campaigns table extended by
 * 035_campaigns_extensions. The legacy `name` / `action_type` /
 * `points_per_completion` columns are kept populated from the new
 * `title` / `intent_type` / `reward_points` fields in the request body
 * so downstream reads that still expect the old column names keep
 * working. The new structured columns (`action_url_template`,
 * `eligibility`, `budget`, `verification_config`) are populated from
 * the rich body fields.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireBearerAuth, requireProtocolOwner } from "../middleware/auth.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Validation schemas                                                        */
/* -------------------------------------------------------------------------- */

const eligibilitySchema = z
  .object({
    min_amount_usd: z.number().nonnegative().optional(),
    max_amount_usd: z.number().nonnegative().optional(),
    one_reward_per_wallet_per_day: z.boolean().optional(),
    new_user_only: z.boolean().optional(),
  })
  .strict();

const budgetSchema = z
  .object({
    max_awards: z.number().int().positive(),
    max_total_points: z.number().int().positive().optional(),
  })
  .strict();

const createCampaignBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    intent_type: z.string().min(1),
    action_url_template: z.string().url(),
    verification_adapter: z.string().min(1),
    reward_points: z.number().int().positive(),
    eligibility: eligibilitySchema,
    budget: budgetSchema,
    start_at: z.string().datetime(),
    end_at: z.string().datetime(),
  })
  .strict();

type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;

const VALID_STATUSES = [
  "draft",
  "review",
  "live",
  "paused",
  "completed",
  "exhausted",
  "active", // legacy default from 005 migration — treat as live
] as const;
type CampaignStatus = (typeof VALID_STATUSES)[number];

const updateCampaignBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).optional(),
    intent_type: z.string().min(1).optional(),
    action_url_template: z.string().url().optional(),
    verification_adapter: z.string().min(1).optional(),
    reward_points: z.number().int().positive().optional(),
    eligibility: eligibilitySchema.optional(),
    budget: budgetSchema.optional(),
    start_at: z.string().datetime().optional(),
    end_at: z.string().datetime().optional(),
    status: z.enum(VALID_STATUSES).optional(),
  })
  .strict();

type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;

const listCampaignsQuerySchema = z
  .object({
    status: z.enum(VALID_STATUSES).optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    page: z.coerce.number().int().positive().default(1),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Status transition rules                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Legal status transitions for a campaign. `completed` and `exhausted`
 * are terminal — once a campaign lands there it cannot move back to
 * `live` or `paused`. `active` is the legacy default from 005 migration;
 * treat it as equivalent to `live` for transition purposes so older
 * rows can still be moved into the new state machine.
 */
const TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["draft", "review", "live"],
  review: ["review", "draft", "live"],
  live: ["live", "paused", "completed", "exhausted"],
  active: ["active", "paused", "completed", "exhausted", "live"],
  paused: ["paused", "live", "completed"],
  completed: ["completed"],
  exhausted: ["exhausted"],
};

function isLegalTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "Bad Request", message });
}

function notFound(reply: FastifyReply, message: string) {
  return reply.status(404).send({ error: "Not Found", message });
}

function internalError(reply: FastifyReply, message: string) {
  return reply.status(500).send({ error: "Internal Server Error", message });
}

interface CampaignRow {
  campaign_id: string;
  protocol_id: string;
  name: string;
  description: string | null;
  action_type: string;
  action_url_template: string | null;
  points_per_completion: number;
  verification_config: unknown;
  eligibility: unknown;
  budget: unknown;
  budget_total: string | null;
  budget_spent: string | null;
  awarded_count: number;
  start_at: Date | null;
  end_at: Date | null;
  status: string;
  created_at: Date;
  last_awarded_at: Date | null;
}

function serializeCampaign(row: CampaignRow) {
  return {
    campaignId: row.campaign_id,
    protocolId: row.protocol_id,
    title: row.name,
    description: row.description,
    intent_type: row.action_type,
    action_url_template: row.action_url_template,
    reward_points: row.points_per_completion,
    verification_config: row.verification_config,
    eligibility: row.eligibility,
    budget: row.budget,
    budget_total: row.budget_total,
    budget_spent: row.budget_spent,
    awarded_count: row.awarded_count,
    start_at: row.start_at ? row.start_at.toISOString() : null,
    end_at: row.end_at ? row.end_at.toISOString() : null,
    status: row.status,
    created_at: row.created_at.toISOString(),
    last_awarded_at: row.last_awarded_at
      ? row.last_awarded_at.toISOString()
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface ProtocolParams {
  id: string;
}

interface ProtocolCampaignParams {
  id: string;
  campaignId: string;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /protocols/:id/campaigns ------ */
  app.post<{ Params: ProtocolParams; Body: CreateCampaignBody }>(
    "/protocols/:id/campaigns",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const parse = createCampaignBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const body = parse.data;
      const { id: protocolId } = request.params;

      // TODO(plan-41): enforce that the protocol has an active stake >=
      // the category minimum before allowing a new campaign. The on-chain
      // stake lookup isn't trivial yet — Session 4 wires this up when the
      // protocol_stakes table / chain reader lands.
      // TODO(plan-41): enforce issuance capacity (points remaining in the
      // protocol's daily/seasonal budget). Same rationale — Session 4.

      try {
        const verificationConfig = {
          adapter: body.verification_adapter,
        };

        const result = await query<CampaignRow>(
          `INSERT INTO campaigns (
             protocol_id,
             name,
             description,
             action_type,
             action_url_pattern,
             action_url_template,
             points_per_completion,
             budget_total,
             verification_config,
             eligibility,
             budget,
             start_at,
             end_at,
             status
           )
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, 'draft')
           RETURNING campaign_id, protocol_id, name, description, action_type,
                     action_url_template, points_per_completion,
                     verification_config, eligibility, budget,
                     budget_total::text AS budget_total,
                     budget_spent::text AS budget_spent,
                     awarded_count, start_at, end_at, status, created_at,
                     last_awarded_at`,
          [
            protocolId,
            body.title,
            body.description,
            body.intent_type,
            body.action_url_template,
            body.reward_points,
            body.budget.max_total_points ?? null,
            JSON.stringify(verificationConfig),
            JSON.stringify(body.eligibility),
            JSON.stringify(body.budget),
            body.start_at,
            body.end_at,
          ],
        );

        return reply.status(201).send(serializeCampaign(result.rows[0]));
      } catch (err) {
        request.log.error(err, "Failed to create campaign");
        return internalError(reply, "Failed to create campaign");
      }
    },
  );

  /* ------ PUT /protocols/:id/campaigns/:campaignId ------ */
  app.put<{ Params: ProtocolCampaignParams; Body: UpdateCampaignBody }>(
    "/protocols/:id/campaigns/:campaignId",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const parse = updateCampaignBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const body = parse.data;
      const { id: protocolId, campaignId } = request.params;

      // Fetch the existing row first so we can (a) 404 correctly if the
      // campaign doesn't exist or belongs to a different protocol, and
      // (b) validate the status transition without racing the UPDATE.
      const existing = await query<{ status: string }>(
        `SELECT status FROM campaigns
          WHERE campaign_id = $1 AND protocol_id = $2
          LIMIT 1`,
        [campaignId, protocolId],
      );
      if (existing.rowCount === 0) {
        return notFound(reply, "Campaign not found");
      }

      if (body.status) {
        const fromStatus = existing.rows[0].status as CampaignStatus;
        if (!isLegalTransition(fromStatus, body.status)) {
          return badRequest(
            reply,
            `Illegal status transition: ${fromStatus} → ${body.status}`,
          );
        }
      }

      const setClauses: string[] = ["updated_at = NOW()"];
      const params: unknown[] = [];
      let idx = 1;

      if (body.title !== undefined) {
        setClauses.push(`name = $${idx++}`);
        params.push(body.title);
      }
      if (body.description !== undefined) {
        setClauses.push(`description = $${idx++}`);
        params.push(body.description);
      }
      if (body.intent_type !== undefined) {
        setClauses.push(`action_type = $${idx++}`);
        params.push(body.intent_type);
      }
      if (body.action_url_template !== undefined) {
        setClauses.push(`action_url_template = $${idx++}`);
        params.push(body.action_url_template);
        setClauses.push(`action_url_pattern = $${idx++}`);
        params.push(body.action_url_template);
      }
      if (body.verification_adapter !== undefined) {
        setClauses.push(`verification_config = $${idx++}::jsonb`);
        params.push(JSON.stringify({ adapter: body.verification_adapter }));
      }
      if (body.reward_points !== undefined) {
        setClauses.push(`points_per_completion = $${idx++}`);
        params.push(body.reward_points);
      }
      if (body.eligibility !== undefined) {
        setClauses.push(`eligibility = $${idx++}::jsonb`);
        params.push(JSON.stringify(body.eligibility));
      }
      if (body.budget !== undefined) {
        setClauses.push(`budget = $${idx++}::jsonb`);
        params.push(JSON.stringify(body.budget));
        if (body.budget.max_total_points !== undefined) {
          setClauses.push(`budget_total = $${idx++}`);
          params.push(body.budget.max_total_points);
        }
      }
      if (body.start_at !== undefined) {
        setClauses.push(`start_at = $${idx++}`);
        params.push(body.start_at);
      }
      if (body.end_at !== undefined) {
        setClauses.push(`end_at = $${idx++}`);
        params.push(body.end_at);
      }
      if (body.status !== undefined) {
        setClauses.push(`status = $${idx++}`);
        params.push(body.status);
      }

      // Only the status-is-the-only-field edge-case can reach here with
      // an effectively empty update (updated_at-only). Reject empty
      // bodies up front so callers don't silently no-op.
      if (setClauses.length === 1) {
        return badRequest(reply, "At least one field to update is required");
      }

      params.push(campaignId);
      params.push(protocolId);

      try {
        const result = await query<CampaignRow>(
          `UPDATE campaigns
              SET ${setClauses.join(", ")}
            WHERE campaign_id = $${idx++} AND protocol_id = $${idx}
            RETURNING campaign_id, protocol_id, name, description, action_type,
                      action_url_template, points_per_completion,
                      verification_config, eligibility, budget,
                      budget_total::text AS budget_total,
                      budget_spent::text AS budget_spent,
                      awarded_count, start_at, end_at, status, created_at,
                      last_awarded_at`,
          params,
        );

        if (result.rowCount === 0) {
          return notFound(reply, "Campaign not found");
        }

        return reply.status(200).send(serializeCampaign(result.rows[0]));
      } catch (err) {
        request.log.error(err, "Failed to update campaign");
        return internalError(reply, "Failed to update campaign");
      }
    },
  );

  /* ------ GET /protocols/:id/campaigns ------ */
  app.get<{
    Params: ProtocolParams;
    Querystring: { status?: string; limit?: string; page?: string };
  }>(
    "/protocols/:id/campaigns",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const parse = listCampaignsQuerySchema.safeParse(request.query);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid query: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const { status, limit, page } = parse.data;
      const { id: protocolId } = request.params;
      const offset = (page - 1) * limit;

      try {
        const filters: string[] = ["protocol_id = $1"];
        const params: unknown[] = [protocolId];
        let idx = 2;

        if (status) {
          filters.push(`status = $${idx++}`);
          params.push(status);
        }

        const whereClause = `WHERE ${filters.join(" AND ")}`;

        const countRes = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM campaigns ${whereClause}`,
          params,
        );
        const total = Number(countRes.rows[0]?.count ?? "0");

        const rowsRes = await query<CampaignRow>(
          `SELECT campaign_id, protocol_id, name, description, action_type,
                  action_url_template, points_per_completion,
                  verification_config, eligibility, budget,
                  budget_total::text AS budget_total,
                  budget_spent::text AS budget_spent,
                  awarded_count, start_at, end_at, status, created_at,
                  last_awarded_at
             FROM campaigns
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${idx++} OFFSET $${idx}`,
          [...params, limit, offset],
        );

        return reply.status(200).send({
          entries: rowsRes.rows.map(serializeCampaign),
          total,
        });
      } catch (err) {
        request.log.error(err, "Failed to list campaigns");
        return internalError(reply, "Failed to list campaigns");
      }
    },
  );

  /* ------ GET /protocols/:id/campaigns/:campaignId/stats ------ */
  app.get<{ Params: ProtocolCampaignParams }>(
    "/protocols/:id/campaigns/:campaignId/stats",
    { preHandler: [requireBearerAuth, requireProtocolOwner] },
    async (request, reply) => {
      const { id: protocolId, campaignId } = request.params;

      // Sanity: make sure the campaign belongs to this protocol so
      // stats reads can't leak across protocol boundaries.
      const existing = await query<{
        awarded_count: number;
        budget_total: string | null;
        budget_spent: string | null;
      }>(
        `SELECT awarded_count,
                budget_total::text AS budget_total,
                budget_spent::text AS budget_spent
           FROM campaigns
          WHERE campaign_id = $1 AND protocol_id = $2
          LIMIT 1`,
        [campaignId, protocolId],
      );
      if (existing.rowCount === 0) {
        return notFound(reply, "Campaign not found");
      }

      try {
        // point_events doesn't carry a campaign_id today, so we attribute
        // awards to the campaign via source_reference matching on the
        // campaign id. Callers that want a stricter attribution should
        // pass `campaign:{campaignId}:…` as the idempotency key when
        // awarding points.
        const statsRes = await query<{
          completion_count: string;
          points_issued: string;
          unique_users: string;
        }>(
          `SELECT COUNT(*)::text                     AS completion_count,
                  COALESCE(SUM(amount), 0)::text     AS points_issued,
                  COUNT(DISTINCT user_wallet)::text  AS unique_users
             FROM point_events
            WHERE protocol_id = $1
              AND source_reference LIKE $2`,
          [protocolId, `%${campaignId}%`],
        );

        const row = statsRes.rows[0];
        const budgetTotal = existing.rows[0].budget_total;
        const budgetSpent = existing.rows[0].budget_spent ?? "0";
        const budgetRemaining =
          budgetTotal !== null
            ? (BigInt(budgetTotal) - BigInt(budgetSpent)).toString()
            : null;

        return reply.status(200).send({
          campaignId,
          completion_count: Number(row?.completion_count ?? "0"),
          points_issued: row?.points_issued ?? "0",
          unique_users: Number(row?.unique_users ?? "0"),
          budget_used: budgetSpent,
          budget_remaining: budgetRemaining,
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch campaign stats");
        return internalError(reply, "Failed to fetch campaign stats");
      }
    },
  );
}
