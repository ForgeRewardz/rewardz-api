import crypto from "node:crypto";
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

interface JwtPayload {
  wallet_address: string;
  iat?: number;
  exp?: number;
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

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;

    if (!payload.wallet_address) {
      unauthorized(reply, "Token missing wallet_address claim");
      return;
    }

    request.walletAddress = payload.wallet_address;
  } catch {
    unauthorized(reply, "Invalid or expired bearer token");
  }
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
