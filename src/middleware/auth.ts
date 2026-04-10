import crypto, { randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { PublicKey } from "@solana/web3.js";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Augmented request types                                                   */
/* -------------------------------------------------------------------------- */

declare module "fastify" {
  interface FastifyRequest {
    /** Set by API-key auth – the authenticated protocol's UUID */
    protocolId?: string;
    /** Set by wallet / bearer auth – the caller's wallet address */
    walletAddress?: string;
    /** Set by internal-key auth */
    isInternalService?: boolean;
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function unauthorized(reply: FastifyReply, message: string): void {
  reply.status(401).send({ error: "Unauthorized", message });
}

/* -------------------------------------------------------------------------- */
/*  1. API-key auth – look up protocol by hashed key                          */
/* -------------------------------------------------------------------------- */

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const apiKey = request.headers["x-api-key"] as string | undefined;

  if (!apiKey) {
    unauthorized(reply, "Missing x-api-key header");
    return;
  }

  // Short-circuit: if the key is the internal service key, reject –
  // callers wanting internal auth should use requireInternalKey instead.
  if (apiKey === config.INTERNAL_API_KEY) {
    unauthorized(reply, "Internal key is not a valid protocol API key");
    return;
  }

  const hash = hashApiKey(apiKey);

  const result = await query<{ id: string }>(
    `SELECT id FROM protocols WHERE api_key_hash = $1 AND status = 'active' LIMIT 1`,
    [hash],
  );

  if (result.rowCount === 0) {
    unauthorized(reply, "Invalid or inactive API key");
    return;
  }

  request.protocolId = result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  2. Wallet signature auth – ed25519 signature over a message               */
/* -------------------------------------------------------------------------- */

export async function requireWalletAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const walletAddress = request.headers["x-wallet-address"] as
    | string
    | undefined;
  const signatureHex = request.headers["x-wallet-signature"] as
    | string
    | undefined;

  if (!walletAddress || !signatureHex) {
    unauthorized(
      reply,
      "Missing x-wallet-address or x-wallet-signature header",
    );
    return;
  }

  try {
    const publicKey = new PublicKey(walletAddress);
    const message = Buffer.from(
      `Sign in to REWARDZ with wallet ${walletAddress}`,
    );
    const signature = Buffer.from(signatureHex, "base64");

    // Use Node.js built-in ed25519 verification
    const ed25519PubKey = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 DER public key prefix (12 bytes)
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey.toBytes()),
      ]),
      format: "der",
      type: "spki",
    });

    const valid = crypto.verify(null, message, ed25519PubKey, signature);

    if (!valid) {
      unauthorized(reply, "Invalid wallet signature");
      return;
    }

    request.walletAddress = walletAddress;
  } catch {
    unauthorized(reply, "Wallet signature verification failed");
  }
}

/* -------------------------------------------------------------------------- */
/*  3. Bearer token auth – JWT                                                */
/* -------------------------------------------------------------------------- */

/**
 * Canonical protocol session JWT claims. `signProtocolSessionJWT` stamps
 * all of these; `requireBearerAuth` verifies `aud`, `iss`, and the
 * `jti` revocation flag on every request.
 */
export interface ProtocolSessionClaims {
  wallet_address: string;
  jti: string;
  aud: "rewardz-api";
  iss: "rewardz-console";
  iat: number;
  exp: number;
}

export interface SignProtocolSessionJWTArgs {
  wallet: string;
  /** Optional pre-generated jti — callers usually pass
   *  `protocol_auth_sessions.id` so logout can revoke by that row. */
  jti?: string;
}

export interface SignedProtocolSessionJWT {
  token: string;
  jti: string;
  expiresAt: Date;
}

/**
 * Sign a short-lived (15 min) protocol session JWT. The returned token
 * includes a `jti` for server-side revocation via protocol_auth_sessions
 * and the fixed `aud`/`iss` claims `requireBearerAuth` asserts.
 */
export function signProtocolSessionJWT(
  args: SignProtocolSessionJWTArgs,
): SignedProtocolSessionJWT {
  const jti = args.jti ?? randomUUID();
  const expiresIn = 15 * 60; // 15 minutes
  const token = jwt.sign({ wallet_address: args.wallet }, config.JWT_SECRET, {
    expiresIn,
    jwtid: jti,
    audience: "rewardz-api",
    issuer: "rewardz-console",
  });
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  return { token, jti, expiresAt };
}

/**
 * Generate a URL-safe, unguessable nonce for `/v1/auth/challenge`.
 * 32 bytes of CSPRNG entropy rendered as base64url — ~256 bits, more
 * than enough to resist any practical guessing attack.
 */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Lazy-injected JWT revocation check. Default is a noop so this module
 * stays importable without a pg pool (e.g. in unit tests). The
 * auth-sessions service wires the real implementation at startup via
 * `setJtiRevocationCheck`. Tests may override with a fake.
 */
type JtiRevocationCheck = (jti: string) => Promise<boolean>;
let isJtiRevokedImpl: JtiRevocationCheck = async () => false;

export function setJtiRevocationCheck(fn: JtiRevocationCheck): void {
  isJtiRevokedImpl = fn;
}

export async function requireBearerAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    unauthorized(reply, "Missing or malformed Authorization header");
    return;
  }

  const token = authHeader.slice(7);

  let payload: ProtocolSessionClaims;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, {
      audience: "rewardz-api",
      issuer: "rewardz-console",
    }) as ProtocolSessionClaims;
  } catch {
    unauthorized(reply, "Invalid or expired bearer token");
    return;
  }

  if (!payload.wallet_address) {
    unauthorized(reply, "Token missing wallet_address claim");
    return;
  }
  if (!payload.jti) {
    unauthorized(reply, "Token missing jti claim");
    return;
  }

  // Revocation check – logout / admin revocation flips revoked_at so
  // any subsequent request on that jti is rejected.
  const revoked = await isJtiRevokedImpl(payload.jti);
  if (revoked) {
    unauthorized(reply, "Token has been revoked");
    return;
  }

  request.walletAddress = payload.wallet_address;
}

/* -------------------------------------------------------------------------- */
/*  4. Internal service key – keeper-bot → API calls                          */
/* -------------------------------------------------------------------------- */

export async function requireInternalKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const apiKey = request.headers["x-api-key"] as string | undefined;

  if (!apiKey) {
    unauthorized(reply, "Missing x-api-key header");
    return;
  }

  const keyBuf = Buffer.from(apiKey);
  const expectedBuf = Buffer.from(config.INTERNAL_API_KEY);
  if (
    keyBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(keyBuf, expectedBuf)
  ) {
    unauthorized(reply, "Invalid internal API key");
    return;
  }

  request.isInternalService = true;
}
