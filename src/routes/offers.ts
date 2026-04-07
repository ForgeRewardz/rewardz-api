import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { rankOffers } from "../services/ranking-engine.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Query types                                                               */
/* -------------------------------------------------------------------------- */

interface OffersQuery {
  type?: string;
  protocol?: string;
  sort?: "points" | "score" | "ending_soon";
  page?: string;
  limit?: string;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function offerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/offers", async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as OffersQuery;
    const page = Math.max(1, parseInt(qs.page ?? "1", 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(qs.limit ?? "20", 10) || 20),
    );
    const offset = (page - 1) * limit;

    try {
      // Build dynamic WHERE clauses
      const conditions: string[] = ["c.status = 'active'"];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (qs.type) {
        conditions.push(`c.action_type = $${paramIdx++}`);
        params.push(qs.type);
      }

      if (qs.protocol) {
        conditions.push(`c.protocol_id = $${paramIdx++}`);
        params.push(qs.protocol);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Count total
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM campaigns c
           JOIN protocols p ON p.id = c.protocol_id AND p.status = 'active'
           ${whereClause}`,
        params,
      );
      const total = parseInt(countResult.rows[0].count, 10);

      // Determine ORDER BY
      let orderBy: string;
      switch (qs.sort) {
        case "points":
          orderBy = "c.points_per_completion DESC";
          break;
        case "ending_soon":
          orderBy = "c.end_at ASC NULLS LAST";
          break;
        case "score":
        default:
          orderBy = "c.created_at DESC";
          break;
      }

      // Fetch offers
      const offersResult = await query<{
        campaign_id: string;
        protocol_id: string;
        protocol_name: string;
        action_type: string;
        name: string;
        description: string | null;
        points_per_completion: string;
        trust_score: string;
        start_at: Date;
        end_at: Date | null;
      }>(
        `SELECT c.campaign_id, c.protocol_id, p.name AS protocol_name,
                  c.action_type, c.name, c.description,
                  c.points_per_completion, p.trust_score,
                  c.start_at, c.end_at
           FROM campaigns c
           JOIN protocols p ON p.id = c.protocol_id AND p.status = 'active'
           ${whereClause}
           ORDER BY ${orderBy}
           LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      );

      // Apply ranking when sort=score (default)
      let offers;
      if (!qs.sort || qs.sort === "score") {
        const rankable = offersResult.rows.map((row) => ({
          protocol_id: row.protocol_id,
          action_type: row.action_type,
          points: parseInt(row.points_per_completion, 10),
          trust_score: parseInt(row.trust_score, 10),
          campaign_id: row.campaign_id,
        }));

        const ranked = rankOffers(rankable);

        // Merge ranked data back with row details
        const rankedMap = new Map(ranked.map((r) => [r.campaign_id, r]));
        offers = offersResult.rows.map((row) => {
          const r = rankedMap.get(row.campaign_id);
          return {
            campaign_id: row.campaign_id,
            protocol_id: row.protocol_id,
            protocol_name: row.protocol_name,
            action_type: row.action_type,
            name: row.name,
            description: row.description,
            points_per_completion: parseInt(row.points_per_completion, 10),
            trust_score: parseInt(row.trust_score, 10),
            start_at: row.start_at,
            end_at: row.end_at,
            placement_score: r?.placement_score ?? 0,
            rank: r?.rank ?? 0,
          };
        });

        // Re-sort by rank
        offers.sort((a, b) => a.rank - b.rank);
      } else {
        offers = offersResult.rows.map((row) => ({
          campaign_id: row.campaign_id,
          protocol_id: row.protocol_id,
          protocol_name: row.protocol_name,
          action_type: row.action_type,
          name: row.name,
          description: row.description,
          points_per_completion: parseInt(row.points_per_completion, 10),
          trust_score: parseInt(row.trust_score, 10),
          start_at: row.start_at,
          end_at: row.end_at,
        }));
      }

      return reply.status(200).send({
        offers,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      request.log.error(err, "Failed to fetch offers");
      return reply
        .status(500)
        .send({
          error: "Internal Server Error",
          message: "Failed to fetch offers",
        });
    }
  });
}
