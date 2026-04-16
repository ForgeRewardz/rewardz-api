import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { rateLimit } from "../middleware/rate-limit.js";

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

// Distinct from the existing `/v1/leaderboard/season` family in
// leaderboards.ts — this route serves the Colosseum League daily
// snapshots written by mvp-keeper-bot's leaderboard cron (task 17).
//
// Exact-path match takes precedence in Fastify, so registering
// `/leaderboard` alongside `/leaderboard/season` + `/leaderboard/protocols`
// does NOT collide — each path routes to its own handler.

const LEADERBOARD_DEFAULT_LIMIT = 10;
const LEADERBOARD_MAX_LIMIT = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  date: z.string().regex(ISO_DATE, "date must be YYYY-MM-DD").optional(),
  limit: z
    .string()
    .regex(/^\d+$/, "limit must be a positive integer")
    .transform((s) => Number(s))
    .refine(
      (n) => n >= 1 && n <= LEADERBOARD_MAX_LIMIT,
      `limit must be 1..${LEADERBOARD_MAX_LIMIT}`,
    )
    .optional(),
});

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function leagueLeaderboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * GET /leaderboard
   *
   * Top-N protocols from the most recent daily snapshot. Consumed by
   * mobile + mini-app to render the public leaderboard surface.
   *
   * Query params:
   *   date?  YYYY-MM-DD — pins to a specific snapshot (default: latest)
   *   limit? 1..100 (default 10)
   *
   * Response:
   *   200 {
   *     snapshotDate: "YYYY-MM-DD" | null,
   *     rows: [{ rank, protocolId, adminWallet, qualityScore, visibility,
   *              uniqueWallets, repeatUsers, successfulCompletions,
   *              bonusAwarded, featured }]
   *   }
   *
   * Response contract notes:
   *   - `rows` is empty if no snapshot exists for the requested date
   *     (or any date, if `date` is unspecified). `snapshotDate` is
   *     null in that case.
   *   - BIGINT counters serialise as strings (pg default for bigint)
   *     to avoid JS Number precision loss; the UI can Number() them
   *     since actual magnitudes are well below 2^53.
   *   - `hidden` protocols are excluded at query time — the
   *     leaderboard is a public surface and should honour the
   *     league-config.md §Visibility rule that hidden ≠ discoverable.
   *   - `at_risk` protocols are included with their visibility flag
   *     so the client can render them muted (matching mobile task 73).
   */
  app.get(
    "/leaderboard",
    { preHandler: [rateLimit(60_000, 120)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = querySchema.safeParse(request.query);
      if (!parse.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Invalid query: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        });
      }
      const { date, limit = LEADERBOARD_DEFAULT_LIMIT } = parse.data;

      try {
        // Single round-trip: a CTE resolves the snapshot date
        // (caller-pinned or MAX available), then the main SELECT
        // joins on that. COALESCE($1::date, l.d) keeps the "caller
        // pinned a date" path explicit while reusing the same join
        // target as the default case. The resolved date is echoed
        // back on each row so the handler can return it alongside
        // the leaderboard rows without a second query.
        const rows = await query<{
          snapshot_date: string;
          rank: number;
          protocol_id: string;
          admin_wallet: string;
          quality_score: string | null;
          visibility: "active" | "at_risk" | "hidden";
          unique_wallets: string;
          repeat_users: string;
          successful_completions: string;
          bonus_awarded: string;
          featured: boolean;
        }>(
          `WITH latest AS (
              SELECT MAX(snapshot_date) AS d FROM league_leaderboard_snapshots
           ),
           resolved AS (
              SELECT COALESCE($1::date, (SELECT d FROM latest)) AS d
           )
           SELECT to_char(s.snapshot_date, 'YYYY-MM-DD') AS snapshot_date,
                  s.rank,
                  s.protocol_id,
                  p.admin_wallet,
                  p.quality_score::text AS quality_score,
                  p.visibility,
                  s.unique_wallets::text AS unique_wallets,
                  s.repeat_users::text   AS repeat_users,
                  s.successful_completions::text AS successful_completions,
                  s.bonus_awarded::text  AS bonus_awarded,
                  s.featured
             FROM league_leaderboard_snapshots s
             JOIN protocols p ON p.id = s.protocol_id
            WHERE s.snapshot_date = (SELECT d FROM resolved)
              AND p.visibility <> 'hidden'
            ORDER BY s.rank ASC
            LIMIT $2`,
          [date ?? null, limit],
        );

        // snapshotDate comes from the first row when present; when
        // no rows match (no snapshot exists, or caller pinned a date
        // with no data), fall back to the caller-supplied date (or
        // null for the default-latest case).
        const snapshotDate = rows.rows[0]?.snapshot_date ?? date ?? null;

        return reply.status(200).send({
          snapshotDate,
          rows: rows.rows.map((r) => ({
            rank: r.rank,
            protocolId: r.protocol_id,
            adminWallet: r.admin_wallet,
            qualityScore:
              r.quality_score == null ? null : Number(r.quality_score),
            visibility: r.visibility,
            uniqueWallets: r.unique_wallets,
            repeatUsers: r.repeat_users,
            successfulCompletions: r.successful_completions,
            bonusAwarded: r.bonus_awarded,
            featured: r.featured,
          })),
        });
      } catch (err) {
        request.log.error(err, "Failed to read league leaderboard");
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to read league leaderboard",
        });
      }
    },
  );
}
