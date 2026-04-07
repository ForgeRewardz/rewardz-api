import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface WindowEntry {
  timestamps: number[];
}

/* -------------------------------------------------------------------------- */
/*  In-memory store with periodic cleanup                                     */
/* -------------------------------------------------------------------------- */

const store = new Map<string, WindowEntry>();

// Cleanup stale entries every 60 seconds
const CLEANUP_INTERVAL_MS = 60_000;

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    // Remove timestamps older than 2 minutes (generous cleanup window)
    entry.timestamps = entry.timestamps.filter((t) => now - t < 120_000);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Allow the process to exit cleanly without waiting for the timer
cleanupTimer.unref();

/* -------------------------------------------------------------------------- */
/*  Identify the caller – API key or wallet address                           */
/* -------------------------------------------------------------------------- */

function getClientKey(request: FastifyRequest): string {
  if (request.protocolId) return `protocol:${request.protocolId}`;
  if (request.walletAddress) return `wallet:${request.walletAddress}`;

  const apiKey = request.headers["x-api-key"] as string | undefined;
  if (apiKey) return `apikey:${apiKey}`;

  // Fallback to IP
  return `ip:${request.ip}`;
}

/* -------------------------------------------------------------------------- */
/*  Rate limiter factory                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Create a rate-limit preHandler hook.
 *
 * @param windowMs  Sliding window duration in milliseconds (default: 60 000)
 * @param maxRequests  Max requests per window (default: config.POINTS_AWARD_RATE_LIMIT)
 */
export function rateLimit(
  windowMs?: number,
  maxRequests?: number,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const window = windowMs ?? 60_000;
  const max = maxRequests ?? config.POINTS_AWARD_RATE_LIMIT;

  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const key = getClientKey(request);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Trim timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((t) => now - t < window);

    if (entry.timestamps.length >= max) {
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = window - (now - oldestInWindow);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      reply
        .status(429)
        .header("Retry-After", String(retryAfterSec))
        .send({
          error: "Too Many Requests",
          message: `Rate limit exceeded. Try again in ${retryAfterSec}s.`,
          retry_after: retryAfterSec,
        });
      return;
    }

    entry.timestamps.push(now);
  };
}
