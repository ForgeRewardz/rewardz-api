/**
 * CORS middleware for Solana Actions routes (`/v1/blinks/*` and
 * `/actions.json`).
 *
 * The global `@fastify/cors` plugin is configured in `server.ts` to
 * short-circuit for these paths (task 71a) because dial.to requires
 * a wider-than-default header set — specifically
 * `Access-Control-Allow-Private-Network: true` on preflight, which
 * isn't part of the standard CORS middleware's vocabulary.
 *
 * This plugin registers an `onRequest` hook that matches blink paths
 * AND a preflight OPTIONS route that returns 204 + the
 * ACTIONS_CORS_HEADERS set. The header values follow dial.to's
 * interop contract — do not narrow them without co-ordinating with
 * the console team. TODO-0015 §15G "API note — action headers" is
 * the authoritative spec.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/* -------------------------------------------------------------------------- */
/*  Headers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical CORS header set for Solana Actions responses.
 *
 * Field contracts (ordered by wire sensitivity):
 *
 *   - Access-Control-Allow-Origin: "*" so every dial.to variant
 *     resolves to allowed. This is safe because blink POST handlers
 *     never trust cookies or session state — they return a signed tx
 *     for the caller's wallet to authorise.
 *   - Access-Control-Allow-Methods: GET, POST, OPTIONS. GET returns
 *     ActionGetResponse; POST returns ActionPostResponse; OPTIONS is
 *     the preflight.
 *   - Access-Control-Allow-Headers: Content-Type + Authorization +
 *     Content-Encoding + Accept-Encoding. Last two cover the
 *     gzip/deflate negotiation some actions clients send.
 *   - Access-Control-Expose-Headers: Content-Encoding +
 *     X-Action-Version + X-Blockchain-Ids. The latter two are
 *     dial.to-specific response headers that the action runtime
 *     reads client-side.
 *   - Access-Control-Max-Age: 86400 — one day of preflight caching,
 *     matches the dial.to default.
 *   - Access-Control-Allow-Private-Network: "true" — dial.to sends
 *     a Chrome Private Network preflight when the page is hosted on
 *     a non-public network, and without this the request fails.
 */
export const ACTIONS_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "Access-Control-Expose-Headers":
    "Content-Encoding, X-Action-Version, X-Blockchain-Ids",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Allow-Private-Network": "true",
};

/**
 * Attach the actions CORS headers to a reply. Called by every
 * blink route handler (GET/POST) so the headers land on the
 * response body path as well as the preflight path.
 */
export function applyActionsCorsHeaders(reply: FastifyReply): void {
  for (const [key, value] of Object.entries(ACTIONS_CORS_HEADERS)) {
    reply.header(key, value);
  }
}

/* -------------------------------------------------------------------------- */
/*  Path matcher                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns true when the request URL is one of the actions routes.
 * Kept broad (prefix-match on `/v1/blinks`) so route params and
 * query strings don't break the match.
 */
export function isActionsPath(url: string): boolean {
  // Split off the querystring so comparisons ignore trailing ?args=...
  const path = url.split("?", 1)[0];
  if (path === "/actions.json") return true;
  if (path.startsWith("/v1/blinks/")) return true;
  if (path === "/v1/blinks") return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fastify plugin that:
 *
 *   1. Attaches `ACTIONS_CORS_HEADERS` to every response for an
 *      actions path (onRequest hook) so GET/POST handlers don't
 *      have to remember.
 *   2. Short-circuits OPTIONS requests for actions paths with a
 *      204 + header set (preHandler route for `OPTIONS *`).
 *
 * Safe to register after the global `@fastify/cors` plugin because
 * the server-level delegator (task 71a) returns `{ preflight:
 * false }` for blink paths — meaning `@fastify/cors` does NOT
 * intercept OPTIONS on those paths, leaving it to this plugin.
 */
export async function corsActionsPlugin(
  app: FastifyInstance,
): Promise<void> {
  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isActionsPath(request.url)) return;

      // Attach headers to every actions response (GET/POST), not
      // just the OPTIONS preflight. Clients cache the headers from
      // the last response so skipping non-preflight would leak the
      // global allowlist on the next round trip.
      applyActionsCorsHeaders(reply);

      // Short-circuit OPTIONS preflight with 204. Return the reply
      // itself so Fastify stops processing hooks for this request.
      if (request.method === "OPTIONS") {
        return reply.status(204).send();
      }
    },
  );
}

export default corsActionsPlugin;
