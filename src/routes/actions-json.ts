/**
 * Root /actions.json sitemap.
 *
 * dial.to reads this root-level JSON to discover every action the
 * host exposes. For MVP we aggregate every `live` blink across every
 * protocol into a flat `rules` array:
 *
 *   {
 *     "rules": [
 *       {
 *         "pathPattern": "/v1/blinks/<protocolId>/<slug>/<hash>",
 *         "apiPath":     "/v1/blinks/<protocolId>/<slug>/<hash>"
 *       },
 *       ...
 *     ]
 *   }
 *
 * Both fields are identical because api/ hosts the canonical route —
 * no rewriting is necessary. A future version may split
 * `pathPattern` (the public-facing URL) from `apiPath` (the
 * internal route) so the console can host blinks behind a proxy.
 *
 * Public route, no auth. CORS headers come from the global
 * corsActionsPlugin onRequest hook registered in server.ts.
 *
 * Authoritative spec: TODO-0015 §15G "API note — actions.json
 * sitemap aggregator".
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { listPublishedBlinks } from "../services/blinks-service.js";
import { applyActionsCorsHeaders } from "../middleware/cors-actions.js";

interface ActionRule {
  pathPattern: string;
  apiPath: string;
}

interface ActionsJsonResponse {
  rules: ActionRule[];
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function actionsJsonRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/actions.json",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const blinks = await listPublishedBlinks();
        const rules: ActionRule[] = blinks.map((b) => {
          const path = b.fixedAccountsHash
            ? `/v1/blinks/${b.protocolId}/${b.instructionSlug}/${b.fixedAccountsHash}`
            : `/v1/blinks/${b.protocolId}/${b.instructionSlug}`;
          return { pathPattern: path, apiPath: path };
        });

        const response: ActionsJsonResponse = { rules };

        applyActionsCorsHeaders(reply);
        return reply.status(200).send(response);
      } catch (err) {
        _request.log.error(err, "actions.json aggregation failed");
        applyActionsCorsHeaders(reply);
        return reply
          .status(500)
          .send({ error: "Failed to aggregate actions.json" });
      }
    },
  );

  // Explicit OPTIONS handler for the sitemap route. Mirrors the
  // pattern in blinks-runtime.ts — fastify's router requires an
  // OPTIONS method to be registered before the onRequest hook can
  // mutate the response on preflight.
  app.options(
    "/actions.json",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      applyActionsCorsHeaders(reply);
      return reply.status(204).send();
    },
  );
}

export default actionsJsonRoutes;
