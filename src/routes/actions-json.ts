/**
 * Root /actions.json sitemap.
 *
 * dial.to reads this root-level JSON to discover every action the
 * host exposes. For MVP we aggregate two sources of Blinks into a
 * flat `rules` array:
 *
 *   1. Manifest-driven runtime blinks published via
 *      `blinks-publish.ts` + served by `blinks-runtime.ts` at
 *      `/v1/blinks/:protocolId/:instructionSlug/:fixedAccountsHash?`.
 *      Enumerated via `listPublishedBlinks()`.
 *
 *   2. Hand-curated MVP Blinks (`user_stake` + `create_rental`)
 *      surfaced at dedicated, human-readable paths:
 *        - `/v1/blinks/user-stake/{protocolId}`      (task 41)
 *        - `/v1/blinks/create-rental/{protocolId}`   (task 42)
 *      These are emitted for every protocol that is "ready" —
 *      i.e. has `status = 'active'` and a non-null `admin_wallet`
 *      — regardless of whether the protocol has published any
 *      manifest-driven blink. The curated Blinks implement a
 *      fixed REWARDZ-program flow that doesn't depend on a
 *      per-protocol manifest.
 *
 * Output shape (Solana Actions `ActionsJson`):
 *
 *   {
 *     "rules": [
 *       {
 *         "pathPattern": "/v1/blinks/<protocolId>/<slug>/<hash>",
 *         "apiPath":     "/v1/blinks/<protocolId>/<slug>/<hash>"
 *       },
 *       {
 *         "pathPattern": "/v1/blinks/user-stake/<protocolId>",
 *         "apiPath":     "/v1/blinks/user-stake/<protocolId>"
 *       },
 *       ...
 *     ]
 *   }
 *
 * Both `pathPattern` and `apiPath` are identical for every rule
 * because api/ hosts the canonical route — no rewriting is
 * necessary. A future version may split the two so the console can
 * host blinks behind a proxy.
 *
 * Duplicate-avoidance: the curated paths (`/v1/blinks/user-stake/<p>`,
 * `/v1/blinks/create-rental/<p>`) use a different URL shape than the
 * manifest-driven paths (`/v1/blinks/<p>/<slug>/<hash>`), so they
 * cannot collide. The aggregator still de-duplicates the final
 * `rules` array by `pathPattern` as a defence-in-depth measure in
 * case a future route layout overlaps.
 *
 * Public route, no auth. CORS headers are applied via
 * `applyActionsCorsHeaders` (same pattern as the runtime routes)
 * and the global `corsActionsPlugin` onRequest hook also matches
 * `/actions.json` — the explicit apply is a defensive re-application
 * because Fastify's reply lifecycle can drop headers set only by
 * the onRequest hook on some error paths.
 *
 * Authoritative spec: TODO-0015 §15G "API note — actions.json
 * sitemap aggregator"; TODO-0018 plan task 43.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { query } from "../db/client.js";
import { listPublishedBlinks } from "../services/blinks-service.js";
import { applyActionsCorsHeaders } from "../middleware/cors-actions.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface ActionRule {
  pathPattern: string;
  apiPath: string;
}

interface ActionsJsonResponse {
  rules: ActionRule[];
}

/* -------------------------------------------------------------------------- */
/*  Curated Blink route templates                                             */
/* -------------------------------------------------------------------------- */

/**
 * Path templates for the hand-curated MVP Blinks. `{protocolId}` is
 * substituted at aggregation time with the actual protocol UUID.
 *
 * Kept in lockstep with the Fastify route registrations in
 * `blinks-user-stake.ts` and `blinks-create-rental.ts`. If either
 * handler's path changes, the corresponding template here must
 * change too — otherwise dial.to will fetch the old URL and 404.
 */
const CURATED_BLINK_TEMPLATES: ReadonlyArray<string> = [
  "/v1/blinks/user-stake/{protocolId}",
  "/v1/blinks/create-rental/{protocolId}",
] as const;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Enumerate every protocol that is "ready" for the hand-curated
 * Blinks. A protocol is ready when it is `status = 'active'` (the
 * natural predicate — the admin / protocols routes transition rows
 * into this status once the protocol is live) AND has a non-null
 * `admin_wallet` (defensive; the column is declared NOT NULL in
 * migration 003 but guarding in SQL keeps this query resilient to
 * future schema drift).
 *
 * Returns protocol UUIDs as strings, ordered for stable output so
 * consecutive calls produce an identical `rules` array — dial.to
 * caches the sitemap and churning the order wastes cache hits.
 */
async function listCuratedReadyProtocolIds(): Promise<string[]> {
  const result = await query<{ id: string }>(
    `SELECT id
       FROM protocols
      WHERE status = 'active'
        AND admin_wallet IS NOT NULL
      ORDER BY id ASC`,
  );
  return result.rows.map((r) => r.id);
}

/**
 * De-duplicate rules by `pathPattern`. Later entries win — but
 * because the two sources (manifest-driven + curated) use
 * disjoint URL shapes, this is a defence-in-depth step rather
 * than a semantic requirement.
 */
function dedupeRulesByPath(rules: ActionRule[]): ActionRule[] {
  const seen = new Set<string>();
  const out: ActionRule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.pathPattern)) continue;
    seen.add(rule.pathPattern);
    out.push(rule);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function actionsJsonRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/actions.json",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Source 1: manifest-driven blinks.
        const blinks = await listPublishedBlinks();
        const manifestRules: ActionRule[] = blinks.map((b) => {
          const path = b.fixedAccountsHash
            ? `/v1/blinks/${b.protocolId}/${b.instructionSlug}/${b.fixedAccountsHash}`
            : `/v1/blinks/${b.protocolId}/${b.instructionSlug}`;
          return { pathPattern: path, apiPath: path };
        });

        // Source 2: hand-curated user_stake + create_rental Blinks,
        // one pair per ready protocol.
        const readyProtocolIds = await listCuratedReadyProtocolIds();
        const curatedRules: ActionRule[] = [];
        for (const protocolId of readyProtocolIds) {
          for (const template of CURATED_BLINK_TEMPLATES) {
            const path = template.replace("{protocolId}", protocolId);
            curatedRules.push({ pathPattern: path, apiPath: path });
          }
        }

        const rules = dedupeRulesByPath([
          ...manifestRules,
          ...curatedRules,
        ]);

        const response: ActionsJsonResponse = { rules };

        applyActionsCorsHeaders(reply);
        return reply.status(200).send(response);
      } catch (err) {
        request.log.error(err, "actions.json aggregation failed");
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
