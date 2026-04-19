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
import {
  requireBearerAuth,
  requireProtocolOwner,
  requireWalletAuth,
} from "../middleware/auth.js";
import { query } from "../db/client.js";
import { awardPoints } from "../services/points-service.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic UUID for the wallet-connect bonus campaign row seeded by
 * `scripts/seed-rewardz-protocol.sql`. The mini-app-ux-spec.md §6 flow
 * pins this campaign as the single source of truth for the 100-point
 * wallet-connect bonus — hard-coding the UUID here keeps the claim route
 * a single indexed lookup instead of a brittle `WHERE name = ...` scan.
 */
const WALLET_CONNECT_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";

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

/**
 * Body for POST /campaigns/wallet-connect/claim.
 *
 * `wallet` MUST match the authenticated wallet from `requireWalletAuth`
 * — the handler enforces equality and 403s otherwise. We still require
 * it on the body so the payload matches the rest of the campaign/award
 * surfaces and so a log line captures the claimed wallet explicitly.
 *
 * `ref` is an optional 4..32 alphanumeric referral code sourced from
 * `localStorage.rewardz.ref` by the mini-app. Attribution is best-effort
 * — the handler only logs it today (see handler comments for why we do
 * NOT make an internal HTTP hop to /v1/referrals/attribute).
 */
const walletConnectClaimBodySchema = z
  .object({
    wallet: z.string().min(1),
    ref: z.string().min(1).max(32).optional(),
  })
  .strict();

type WalletConnectClaimBody = z.infer<typeof walletConnectClaimBodySchema>;

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

      // campaigns has no updated_at column (005 schema), so we don't
      // stamp one. Empty-body rejection is handled below after we
      // finish populating setClauses.
      const setClauses: string[] = [];
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

      if (setClauses.length === 0) {
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

  /* ------ POST /campaigns/wallet-connect/claim ------ */
  /**
   * Public (wallet-auth'd) claim route for the wallet-connect bonus
   * campaign seeded by `scripts/seed-rewardz-protocol.sql`. Unlike the
   * protocol-scoped CRUD above this lives at a flat path because the
   * mini-app (mini-app-ux-spec.md §6) doesn't know — and shouldn't need
   * to know — the protocol UUID that owns the campaign.
   *
   * Idempotency is delegated to `awardPoints` via a per-wallet
   * reference key `wallet-connect:<wallet>`. A second claim for the
   * same wallet returns `{ awarded: false, reason: "already_claimed" }`
   * with no ledger mutation — the dup branch ROLLBACKs inside
   * `awardPoints` before any write.
   *
   * `enforceCapacity: false` is deliberate: this is a platform bonus,
   * not a league-gated award. Passing `true` here would make the claim
   * fail if the Rewardz protocol happened to be over its league cap,
   * which would be the wrong UX for an onboarding incentive.
   */
  app.post<{ Body: WalletConnectClaimBody }>(
    "/campaigns/wallet-connect/claim",
    { preHandler: [requireWalletAuth] },
    async (request, reply) => {
      const parse = walletConnectClaimBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const body = parse.data;

      // Wallet-match guard: the authenticated wallet (set by
      // requireWalletAuth) MUST equal the wallet in the body. Without
      // this a caller could sign in as wallet A and award points to
      // wallet B by changing the body — the reference idempotency key
      // uses body.wallet, so a mismatch would also quietly bypass the
      // "already_claimed" check for the real owner of that wallet.
      if (request.walletAddress !== body.wallet) {
        return reply.status(403).send({ error: "wallet_mismatch" });
      }

      try {
        const campaignRes = await query<{
          campaign_id: string;
          protocol_id: string;
          points_per_completion: number;
          status: string;
          start_at: Date | null;
          end_at: Date | null;
        }>(
          `SELECT campaign_id, protocol_id, points_per_completion, status,
                  start_at, end_at
             FROM campaigns
            WHERE campaign_id = $1
            LIMIT 1`,
          [WALLET_CONNECT_CAMPAIGN_ID],
        );

        if (campaignRes.rowCount === 0) {
          return reply.status(503).send({
            awarded: false,
            reason: "campaign_not_seeded",
          });
        }

        const row = campaignRes.rows[0];
        const now = new Date();
        const startOk = row.start_at === null || row.start_at <= now;
        const endOk = row.end_at === null || row.end_at >= now;
        if (row.status !== "active" || !startOk || !endOk) {
          return reply.status(200).send({
            awarded: false,
            reason: "campaign_inactive",
          });
        }

        // Explicit "already claimed" check: require an actual `point_events`
        // row that (a) targets this wallet, (b) uses the wallet-connect
        // reference key, (c) is of type 'awarded', and (d) has amount > 0.
        // This is intentionally stronger than relying on awardPoints' own
        // `source_reference`-unique guard — `already_claimed` is a
        // user-facing signal and we want it backed by a concrete "received
        // N points on T" record, not the absence-of-INSERT side-effect.
        //
        // `source_reference` is UNIQUE (migration 018_point_events.sql); at
        // most one row can match. `ORDER BY created_at ASC LIMIT 1` is
        // defensive — explicit and cheap — so a future relaxation of that
        // constraint doesn't silently change behaviour here.
        const referenceKey = `wallet-connect:${body.wallet}`;
        const priorAward = await query<{
          id: string;
          amount: string;
          created_at: Date;
          reason: string | null;
        }>(
          `SELECT id, amount::text AS amount, created_at, reason
             FROM point_events
            WHERE user_wallet       = $1
              AND source_reference  = $2
              AND type              = 'awarded'
              AND amount            > 0
            ORDER BY created_at ASC
            LIMIT 1`,
          [body.wallet, referenceKey],
        );

        if (priorAward.rowCount && priorAward.rowCount > 0) {
          const award = priorAward.rows[0];
          // Number() is safe for `points_per_completion` up to 2^53 - 1
          // (~9.007e15). The schema stores `amount` as BIGINT; pg returns
          // it as string to preserve precision. If a future campaign ever
          // needs a point amount beyond 2^53 this must move to a string
          // (BigInt) on the wire.
          return reply.status(200).send({
            awarded: false,
            reason: "already_claimed",
            points: Number(award.amount),
            eventId: award.id,
            awardedAt: award.created_at.toISOString(),
          });
        }

        const result = await awardPoints(
          body.wallet,
          BigInt(row.points_per_completion),
          row.protocol_id,
          { type: "reference", key: referenceKey },
          "wallet_connect_bonus",
          "api",
          { enforceCapacity: false },
        );

        if (result.duplicate === true) {
          // Narrow race window: another request awarded this wallet between
          // our priorAward read and the awardPoints call. Re-query so the
          // response carries the real amount + timestamp instead of the
          // campaign default.
          const raceAward = await query<{
            id: string;
            amount: string;
            created_at: Date;
          }>(
            `SELECT id, amount::text AS amount, created_at
               FROM point_events
              WHERE user_wallet      = $1
                AND source_reference = $2
                AND type             = 'awarded'
                AND amount           > 0
              ORDER BY created_at ASC
              LIMIT 1`,
            [body.wallet, referenceKey],
          );
          if (raceAward.rowCount && raceAward.rowCount > 0) {
            const award = raceAward.rows[0];
            return reply.status(200).send({
              awarded: false,
              reason: "already_claimed",
              points: Number(award.amount),
              eventId: award.id,
              awardedAt: award.created_at.toISOString(),
            });
          }
          // awardPoints reported duplicate but we can't find a matching
          // awarded row — log loudly, this indicates data corruption (e.g.
          // a spent/refunded row with the same reference). Surface an
          // error instead of quietly returning already_claimed with no
          // backing record.
          request.log.error(
            {
              wallet: body.wallet,
              reference: referenceKey,
              eventId: result.event_id,
            },
            "wallet-connect duplicate guard tripped without a matching awarded row",
          );
          return internalError(
            reply,
            "Claim state inconsistent; contact support",
          );
        }

        // Best-effort referral attribution. We intentionally do NOT
        // make an internal HTTP call to /v1/referrals/attribute here —
        // coupling a success-path claim to an in-process HTTP hop is
        // fragile (it would need an internal API key, a fresh wallet
        // signature, or a new unauthenticated path) and the referrals
        // flow has its own dedicated endpoint the mini-app can call in
        // parallel. Log the ref so it's visible in server logs while
        // the service-layer extraction lands in a follow-up.
        if (body.ref) {
          request.log.info(
            { wallet: body.wallet, ref: body.ref },
            "wallet-connect claim with referral code (attribution log-only)",
          );
        }

        return reply.status(200).send({
          awarded: true,
          points: row.points_per_completion,
          newBalance: result.new_balance?.toString() ?? null,
          eventId: result.event_id ?? null,
        });
      } catch (err) {
        request.log.error(err, "Failed to process wallet-connect claim");
        return internalError(reply, "Failed to process wallet-connect claim");
      }
    },
  );
}
