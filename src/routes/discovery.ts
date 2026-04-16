import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  AT_RISK_DAMPENER,
  FEATURED_BOOST,
} from "../services/ranking-engine.js";

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

// TODO-0018 §Mini-app: default discovery tiles = "top 2 community
// Blinks by quality_score" plus the mvp-smart-contracts native Blink.
// The native tile is injected client-side (it's not a DB protocol),
// so this endpoint only returns the community rows. Default limit of
// 6 gives mobile + mini-app room to render a small grid with a
// reasonable pool for deduping against recent impressions.
const DISCOVERY_DEFAULT_LIMIT = 6;
const DISCOVERY_MAX_LIMIT = 50;

const querySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit must be a positive integer")
    .transform((s) => Number(s))
    .refine(
      (n) => n >= 1 && n <= DISCOVERY_MAX_LIMIT,
      `limit must be 1..${DISCOVERY_MAX_LIMIT}`,
    )
    .optional(),
});

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /discovery/featured
   *
   * Default tiles for the mini-app home + mobile discovery surface.
   *
   * Ranking intent (per league-config.md §Visibility and plan tasks
   * 17/18):
   *   1. `hidden` protocols are excluded entirely.
   *   2. `at_risk` protocols are kept but dampened to 50% of
   *      quality_score — matches the ranking-engine's
   *      AT_RISK_DAMPENER so dashboards, /intents/resolve, and this
   *      surface all sink at_risk consistently.
   *   3. Protocols featured in the latest leaderboard snapshot get
   *      a small additive boost (+0.1) so yesterday's winners
   *      surface first even when a higher-quality_score protocol
   *      exists — reflects that "featured" is league-level
   *      recognition that we actively want to promote.
   *   4. Ties broken by creation order (deterministic).
   *
   * Response:
   *   200 {
   *     tiles: [{ protocolId, adminWallet, qualityScore, visibility,
   *               featured, rank, referralCode }]
   *   }
   *
   *   `rank` (number | null) is null when the protocol isn't present
   *   in today's leaderboard snapshot; the tile is still eligible if
   *   its quality_score pulls it into the top-N.
   */
  app.get(
    "/discovery/featured",
    { preHandler: [rateLimit(60_000, 120)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = querySchema.safeParse(request.query);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid query: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }
      const { limit = DISCOVERY_DEFAULT_LIMIT } = parse.data;

      try {
        // LEFT JOIN on the latest snapshot so a protocol that's
        // never been ranked still competes on quality_score alone.
        // The snapshot date sub-select takes MAX(snapshot_date)
        // which handles the "no snapshot yet" case by matching
        // nothing (LEFT JOIN preserves all rows).
        //
        // The score expression is computed in SQL so pagination
        // (future) remains DB-pushed rather than handler-side.
        const rows = await query<{
          protocol_id: string;
          admin_wallet: string;
          quality_score: string | null;
          visibility: "active" | "at_risk";
          featured: boolean;
          rank: number | null;
          referral_code: string | null;
        }>(
          `WITH latest_snapshot AS (
              SELECT MAX(snapshot_date) AS d FROM league_leaderboard_snapshots
          ),
          today_rows AS (
              SELECT s.protocol_id, s.rank, s.featured
                FROM league_leaderboard_snapshots s
                JOIN latest_snapshot l ON s.snapshot_date = l.d
          )
          SELECT p.id              AS protocol_id,
                 p.admin_wallet,
                 p.quality_score::text AS quality_score,
                 p.visibility,
                 COALESCE(t.featured, false) AS featured,
                 t.rank            AS rank,
                 p.referral_code
            FROM protocols p
            LEFT JOIN today_rows t ON t.protocol_id = p.id
           WHERE p.visibility <> 'hidden'
             AND p.status = 'active'
           ORDER BY (
               COALESCE(p.quality_score, 0)::float8
               * CASE WHEN p.visibility = 'at_risk' THEN $2::float8 ELSE 1.0 END
               + CASE WHEN COALESCE(t.featured, false) THEN $3::float8 ELSE 0.0 END
           ) DESC,
             p.created_at ASC
           LIMIT $1`,
          [limit, AT_RISK_DAMPENER, FEATURED_BOOST],
        );

        return reply.status(200).send({
          tiles: rows.rows.map((r) => ({
            protocolId: r.protocol_id,
            adminWallet: r.admin_wallet,
            qualityScore:
              r.quality_score == null ? null : Number(r.quality_score),
            visibility: r.visibility,
            featured: r.featured,
            rank: r.rank,
            referralCode: r.referral_code,
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to read discovery featured tiles");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to read discovery featured tiles",
        });
      }
    },
  );
}
