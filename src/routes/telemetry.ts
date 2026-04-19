/**
 * `POST /v1/telemetry/events` — sink for the mini-app telemetry emitter
 * (`mini-app/src/features/telemetry/events.ts`).
 *
 * Design notes:
 *   * Fire-and-forget from the client. We always ACK 204 so a transient
 *     DB blip never surfaces in the UI, and we cap the payload size to
 *     keep a malicious client from filling the bucket.
 *   * The client contract is stable: `{ type, session_id, t, ...rest }`.
 *     We persist `type` + `session_id` + `t` (client timestamp) in
 *     dedicated columns and stash everything else as `payload` JSONB so
 *     new event shapes don't require a migration.
 *   * No auth. Adding wallet-auth would defeat the anonymous-session
 *     design — the client explicitly omits wallet addresses from the
 *     payload (`type: "wallet_connect_attempted"` / `_awarded` carry no
 *     wallet, only the session id).
 *   * Zod keeps `type` bounded to the client's discriminated union. An
 *     unknown `type` is logged but still ACK'd so a stale client doesn't
 *     get stuck on a rejected event forever.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";

const KNOWN_EVENT_TYPES = [
  "round_view",
  "deploy_attempt",
  "deploy_confirmed",
  "deploy_failed",
  "overlay_shown",
  "share_clicked",
  "discover_cta_clicked",
  "discovery_query_submitted",
  "discovery_schedule_created",
  "discovery_quota_exhausted",
  "wallet_connect_attempted",
  "wallet_connect_awarded",
] as const;

const MAX_PAYLOAD_BYTES = 8 * 1024;

const telemetryEventSchema = z
  .object({
    type: z.string().min(1).max(64),
    session_id: z.string().min(1).max(128),
    t: z.string().datetime().optional(),
  })
  .passthrough();

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/telemetry/events",
    {
      // Gate payload size at the parser, NOT after fastify has already
      // allocated the body. Oversize requests get a 413 back immediately.
      bodyLimit: MAX_PAYLOAD_BYTES,
    },
    async (request, reply) => {
      const raw = request.body;

      const parse = telemetryEventSchema.safeParse(raw);
      if (!parse.success) {
        return reply.code(204).send();
      }

      const { type, session_id, t, ...rest } = parse.data as Record<
        string,
        unknown
      > & { type: string; session_id: string; t?: string };

      const knownType = (KNOWN_EVENT_TYPES as readonly string[]).includes(type)
        ? type
        : "unknown";

      try {
        await query(
          `INSERT INTO telemetry_events (session_id, event_type, payload, client_ts)
         VALUES ($1, $2, $3::jsonb, $4)`,
          [session_id, knownType, JSON.stringify(rest ?? {}), t ?? null],
        );
      } catch (err) {
        // Telemetry failures never propagate. Log once-per-request — fastify
        // logger already rate-limits to the configured level.
        request.log.warn({ err }, "telemetry insert failed");
      }

      return reply.code(204).send();
    },
  );
}
