import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireWalletAuth } from "../middleware/auth.js";
import { resolveIntent } from "../services/intent-resolver.js";
import { rankOffers } from "../services/ranking-engine.js";
import { query } from "../db/client.js";
import type { Protocol } from "../types/index.js";

/* -------------------------------------------------------------------------- */
/*  Request / Response types                                                  */
/* -------------------------------------------------------------------------- */

interface ResolveBody {
  query: string;
  user_wallet: string;
  filters?: {
    action_type?: string;
    protocol?: string;
  };
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function intentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/intents/resolve",
    { preHandler: [requireWalletAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as ResolveBody | undefined;

      if (!body?.query || !body.user_wallet) {
        return reply
          .status(400)
          .send({
            error: "Bad Request",
            message: "query and user_wallet are required",
          });
      }

      try {
        // Fetch active protocols as registry
        const protocolRows = await query<Protocol>(
          `SELECT id, admin_wallet, name, description, blink_base_url, supported_actions,
                  trust_score, status, created_at, updated_at
           FROM protocols
           WHERE status = 'active'`,
        );
        let protocols = protocolRows.rows;

        // Apply optional filters
        if (body.filters?.protocol) {
          protocols = protocols.filter((p) => p.id === body.filters!.protocol);
        }

        // Resolve intent
        const result = await resolveIntent(
          body.query,
          body.user_wallet,
          protocols,
        );

        // Filter by action_type if specified
        let offers = result.offers;
        if (body.filters?.action_type) {
          offers = offers.filter(
            (o) => o.action_type === body.filters!.action_type,
          );
        }

        // Enrich offers with trust_score from protocols for ranking
        const protocolMap = new Map(protocols.map((p) => [p.id, p]));
        const rankable = offers.map((o) => ({
          protocol_id: o.protocol_id,
          action_type: o.action_type,
          points: o.points,
          trust_score: protocolMap.get(o.protocol_id)?.trust_score ?? 0,
        }));

        const ranked = rankOffers(rankable, body.user_wallet);

        return reply.status(200).send({
          intent: result.action_type,
          resolver_type: result.resolver_type,
          resolver_confidence: result.confidence,
          offers: ranked,
          composable_suggestions: [],
        });
      } catch (err) {
        request.log.error(err, "Intent resolution failed");
        return reply
          .status(500)
          .send({
            error: "Internal Server Error",
            message: "Intent resolution failed",
          });
      }
    },
  );
}
