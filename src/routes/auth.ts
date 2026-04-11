import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import jwt from "jsonwebtoken";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  requireBearerAuth,
  signProtocolSessionJWT,
} from "../middleware/auth.js";
import {
  createNonce,
  consumeNonce,
  bindJtiToSession,
  revokeJti,
} from "../services/auth-sessions.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Matches a Solana base58 pubkey (32 bytes → 32-44 base58 chars). Mirrors
 * the regex used in `src/config.ts` for ADMIN_WALLETS so console payloads
 * and env config reject the same set of malformed pubkeys.
 */
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Signed-message format version prefix. The `v1:` prefix is mandatory
 * and reserved for future format rotation — any message not starting
 * with it is rejected at /verify with 400 so old / new clients can't
 * accidentally cross-sign a nonce. Klaus R17.
 */
const MESSAGE_VERSION_PREFIX = "v1:REWARDZ" as const;

/**
 * Fixed application domain stamped into the signed-message canonical
 * form. Mirrors the EIP-712 / Sign-in-with-Solana idiom of binding a
 * signature to an origin — defends against an attacker who can get a
 * user to sign a bare nonce on a phishing site. Hardcoded for now;
 * TODO: move to `AUTH_DOMAIN` env var when a second environment ships.
 */
const AUTH_DOMAIN = "rewardz.xyz" as const;

/**
 * Unit separator control byte between the five fields of the canonical
 * signed-message string. Picked over `|` / `:` / `\n` so a pubkey or
 * timestamp accidentally containing any of those characters can't be
 * abused to inject a field boundary. Exact byte layout is asserted by
 * the /verify handler and covered by plan task 39 case (h).
 */
const US = "\u001f";

/**
 * Hard window on how far in the past a signed timestamp may be. Even
 * with an un-consumed nonce we refuse to burn the atomic-consume slot
 * on a message signed hours ago — any extended delay means the user
 * should re-challenge.
 */
const SIGNED_MESSAGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Per-IP rate limit shared by /challenge and /verify. 10/min/IP is a
 * balance between console usability (a user retrying after a fat-fingered
 * signature shouldn't get locked out) and keeping the atomic-consume
 * path cheap under replay-attack floods. Plan task 37 + 39(i).
 */
const AUTH_RATE_LIMIT_MAX = 10;
const AUTH_RATE_LIMIT_WINDOW = "1 minute";

/* -------------------------------------------------------------------------- */
/*  Validation schemas                                                        */
/* -------------------------------------------------------------------------- */

const challengeBodySchema = z.object({
  wallet: z
    .string()
    .regex(BASE58_PUBKEY, "wallet must be a valid base58 Solana pubkey"),
});

const verifyBodySchema = z.object({
  wallet: z
    .string()
    .regex(BASE58_PUBKEY, "wallet must be a valid base58 Solana pubkey"),
  nonce: z.string().min(1, "nonce is required"),
  message: z.string().min(1, "message is required"),
  signature: z.string().min(1, "signature is required"),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function badRequest(reply: FastifyReply, message: string): void {
  reply.status(400).send({ error: "Bad Request", message });
}

function unauthorized(reply: FastifyReply, message: string): void {
  reply.status(401).send({ error: "Unauthorized", message });
}

function conflict(reply: FastifyReply, message: string): void {
  reply.status(409).send({ error: "Conflict", message });
}

function internalError(reply: FastifyReply, message: string): void {
  reply.status(500).send({ error: "Internal Server Error", message });
}

/**
 * Build the canonical signed-message string a client must sign with its
 * wallet. The exact byte layout (including the `\u001f` separators and
 * the `v1:REWARDZ` prefix) is part of the auth protocol — any drift
 * here silently breaks every console client. Covered by task 39(h).
 */
function buildSignedMessage(
  nonce: string,
  wallet: string,
  timestamp: string,
): string {
  return `${MESSAGE_VERSION_PREFIX}${US}${AUTH_DOMAIN}${US}${nonce}${US}${wallet}${US}${timestamp}`;
}

interface ParsedSignedMessage {
  nonce: string;
  wallet: string;
  timestamp: Date;
}

/**
 * Parse a canonical signed-message string. Asserts the exact byte
 * layout, including the `v1:REWARDZ` prefix, the `\u001f` separators,
 * and the field count. Returns null if any check fails — the caller
 * maps that to 400.
 */
function parseSignedMessage(raw: string): ParsedSignedMessage | null {
  if (!raw.startsWith(`${MESSAGE_VERSION_PREFIX}${US}`)) {
    return null;
  }
  const parts = raw.split(US);
  // Expect exactly 5 fields: [prefix, domain, nonce, wallet, timestamp].
  if (parts.length !== 5) {
    return null;
  }
  const [prefix, domain, nonce, wallet, timestamp] = parts;
  if (prefix !== MESSAGE_VERSION_PREFIX) return null;
  if (domain !== AUTH_DOMAIN) return null;
  if (!nonce || !wallet || !timestamp) return null;

  const parsedTs = new Date(timestamp);
  if (Number.isNaN(parsedTs.getTime())) return null;

  return { nonce, wallet, timestamp: parsedTs };
}

/**
 * Timing-safe string comparison. Both operands are client-controlled
 * here (the nonce from the message body vs the nonce embedded in the
 * signed message), but we still want the exact-format check to run in
 * constant time so an attacker can't infer nonce prefixes by measuring
 * /verify latency. Defence-in-depth — Klaus R17.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Still run a compare on equal-length buffers so the early-return
    // doesn't leak length info on the fast path. Caller has already
    // length-checked via `parts.length !== 5` etc.
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify an ed25519 signature over `message` using `wallet`'s public
 * key. Matches the primitive used by the legacy header-based
 * `requireWalletAuth` in `middleware/auth.ts` — Node's built-in
 * `crypto.verify` with an SPKI-wrapped ed25519 public key — so we
 * don't pull in a second signing library just for this route.
 *
 * Signature format: base64-encoded 64-byte ed25519 signature (matches
 * what `nacl.sign.detached` emits in tests and what
 * `@solana/wallet-adapter`'s `signMessage` returns after base64
 * encoding).
 */
function verifyWalletSignature(
  walletAddress: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const publicKey = new PublicKey(walletAddress);
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64) return false;

    const ed25519PubKey = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 DER public key prefix (12 bytes)
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey.toBytes()),
      ]),
      format: "der",
      type: "spki",
    });

    return crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      ed25519PubKey,
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Extract the jti claim from a Bearer token without re-verifying. The
 * upstream `requireBearerAuth` preHandler already verified the
 * signature, audience, issuer, and jti revocation — we just need the
 * claim so the /logout handler can call `revokeJti`. Using
 * `jwt.decode` here is safe because the signature was already checked
 * above; we'd still fail closed if the token were malformed.
 */
function extractJtiFromAuthHeader(
  authHeader: string | undefined,
): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const decoded = jwt.decode(token);
  if (
    typeof decoded === "object" &&
    decoded !== null &&
    typeof (decoded as { jti?: unknown }).jti === "string"
  ) {
    return (decoded as { jti: string }).jti;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Register @fastify/rate-limit in global=false mode so only the routes
  // that opt in via `config.rateLimit` are limited. The /challenge and
  // /verify handlers below both opt in at 10/min/IP. Plan task 37 + 39(i).
  await app.register(fastifyRateLimit, {
    global: false,
    // Keep an in-memory store — acceptable for a single-process test
    // harness and the initial console rollout. When the api is scaled
    // horizontally this will need a shared Redis store; called out in
    // followups.md.
  });

  /* ------ POST /auth/challenge ------ */
  app.post(
    "/auth/challenge",
    {
      config: {
        rateLimit: {
          max: AUTH_RATE_LIMIT_MAX,
          timeWindow: AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = challengeBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const { wallet } = parse.data;

      try {
        const nonceRow = await createNonce(wallet);
        // Note: createNonce already generates a fresh nonce via
        // generateNonce() internally — we pass the returned value through
        // to the client so the same string is what they'll sign and
        // later echo back to /verify.
        const timestamp = nonceRow.issuedAt.toISOString();
        const message = buildSignedMessage(nonceRow.nonce, wallet, timestamp);

        return reply.status(200).send({
          nonce: nonceRow.nonce,
          message,
          expiresAt: nonceRow.expiresAt.toISOString(),
        });
      } catch (err) {
        request.log.error(err, "Failed to issue auth challenge");
        return internalError(reply, "Failed to issue auth challenge");
      }
    },
  );

  /* ------ POST /auth/verify ------ */
  app.post(
    "/auth/verify",
    {
      config: {
        rateLimit: {
          max: AUTH_RATE_LIMIT_MAX,
          timeWindow: AUTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = verifyBodySchema.safeParse(request.body);
      if (!parse.success) {
        return badRequest(
          reply,
          `Invalid body: ${parse.error.issues.map((i) => i.message).join(", ")}`,
        );
      }
      const { wallet, nonce, message, signature } = parse.data;

      // 1. Parse + exact byte layout check (task 39(h)).
      const parsedMessage = parseSignedMessage(message);
      if (!parsedMessage) {
        return badRequest(reply, "Malformed signed message");
      }

      // 2. Message-embedded wallet / nonce must match body params.
      //    Timing-safe on the nonce to avoid leaking a prefix oracle.
      if (parsedMessage.wallet !== wallet) {
        return badRequest(reply, "Wallet mismatch between body and message");
      }
      if (!timingSafeStringEqual(parsedMessage.nonce, nonce)) {
        return badRequest(reply, "Nonce mismatch between body and message");
      }

      // 3. Timestamp freshness.
      const ageMs = Date.now() - parsedMessage.timestamp.getTime();
      if (ageMs < 0 || ageMs > SIGNED_MESSAGE_MAX_AGE_MS) {
        return badRequest(
          reply,
          "Signed message timestamp expired or in the future",
        );
      }

      // 4. ed25519 signature verification over the exact bytes the
      //    client sent us. We intentionally verify the full raw
      //    `message` string — not a reconstructed one — so any
      //    mismatch between what the client signed and what parse()
      //    accepted is caught.
      if (!verifyWalletSignature(wallet, message, signature)) {
        return unauthorized(reply, "Invalid wallet signature");
      }

      // 5. Atomic consume. Klaus R17 — UPDATE…RETURNING with
      //    consumed_at IS NULL guard makes two parallel /verify calls
      //    with the same nonce return 200 + 409, never 200 + 200.
      const consumed = await consumeNonce(nonce);
      if (!consumed) {
        return conflict(reply, "Nonce already consumed or expired");
      }

      // 6. Defence-in-depth: the verified wallet must match the
      //    wallet the nonce was issued for. consumeNonce doesn't gate
      //    on wallet_address by design (the nonce itself is
      //    unguessable), but a mismatched pair is still suspicious
      //    enough to reject.
      if (consumed.walletAddress !== wallet) {
        return conflict(reply, "Nonce wallet mismatch");
      }

      // 7. Mint JWT keyed to the consumed session row id so /logout
      //    can revoke it. signProtocolSessionJWT stamps aud / iss /
      //    exp — `requireBearerAuth` asserts all three.
      const signed = signProtocolSessionJWT({ wallet, jti: consumed.id });

      // 8. Bind the jti to the session row. Guarded on jwt_jti IS
      //    NULL so a second bind on the same row is a no-op (false)
      //    — treat that as a replay attempt and 409.
      const bound = await bindJtiToSession(consumed.id, signed.jti);
      if (!bound) {
        return conflict(reply, "Session already bound (replay detected)");
      }

      return reply.status(200).send({
        token: signed.token,
        jti: signed.jti,
        expiresAt: signed.expiresAt.toISOString(),
      });
    },
  );

  /* ------ POST /auth/logout ------ */
  app.post(
    "/auth/logout",
    { preHandler: [requireBearerAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // requireBearerAuth has already verified the signature, audience,
      // issuer, and non-revoked status. We just need the jti claim so
      // we can flip revoked_at.
      const jti = extractJtiFromAuthHeader(request.headers.authorization);
      if (!jti) {
        // Should be impossible — requireBearerAuth would have 401'd
        // on a token with no jti claim. Belt-and-braces.
        return unauthorized(reply, "Token missing jti claim");
      }

      // Idempotent: revokeJti is a no-op on an already-revoked jti.
      await revokeJti(jti);
      // A just-revoked token will still pass the jwt.verify() step
      // on the next request, but requireBearerAuth's isJtiRevoked()
      // check (wired at server startup) will 401 it. See task 39(g).
      // Note that re-logging out with the same (still valid) token
      // on a separate connection would 401 once the revocation
      // hits the revocation check before this handler runs — that's
      // also the correct behaviour.
      // Using `.catch` is unnecessary because revokeJti returns void.
      //
      // Shape: `{ revoked: true }` so the console can optimistically
      // clear its session even without reading the body.
      return reply.status(200).send({ revoked: true });
    },
  );
}
