// Idempotency-Key header enforcement.
//
// Per league-config.md §Idempotency: every mutating award/claim route must
// carry an `Idempotency-Key` header (separate from body-level keys). Retries
// with the same header hit the body-level dedupe path and return the original
// event id; missing header is a 400.
//
// The key identity check (has this exact key been seen?) is handled by the
// underlying service layer via UNIQUE(source_reference) on point_events —
// this middleware only enforces presence + minimal format so misbehaving
// clients get a fast-fail.

import type { FastifyRequest, FastifyReply } from "fastify";

const HEADER = "idempotency-key";
const MIN_LEN = 8;
const MAX_LEN = 128;
// Permissive charset: UUIDs, ULIDs, hex, base58 — reject only clearly hostile
// inputs. We're not using this value as a DB key lookup (that's the request
// body's idempotency_key); we're just reflecting the client's request id
// back into logs + confirming the header is present.
const VALID = /^[A-Za-z0-9_-]+$/;

export async function requireIdempotencyKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = request.headers[HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;

  if (!key) {
    reply.status(400).send({
      error: "Bad Request",
      message: `Missing ${HEADER} header`,
    });
    return;
  }

  if (key.length < MIN_LEN || key.length > MAX_LEN || !VALID.test(key)) {
    reply.status(400).send({
      error: "Bad Request",
      message: `Invalid ${HEADER} header (expected ${MIN_LEN}-${MAX_LEN} chars, [A-Za-z0-9_-])`,
    });
    return;
  }

  // Surface header on the request log context so downstream handlers can
  // include it in structured logs without re-reading headers.
  (request as FastifyRequest & { idempotencyKey?: string }).idempotencyKey =
    key;
}
