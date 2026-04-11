import { query } from "../db/client.js";
import { generateNonce, setJtiRevocationCheck } from "../middleware/auth.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface Nonce {
  id: string;
  nonce: string;
  walletAddress: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface ConsumedNonce {
  id: string;
  walletAddress: string;
}

interface NonceRow {
  id: string;
  nonce: string;
  wallet_address: string;
  issued_at: Date;
  expires_at: Date;
}

interface ConsumedNonceRow {
  id: string;
  wallet_address: string;
}

/* -------------------------------------------------------------------------- */
/*  createNonce — issue a fresh 5-minute nonce for a wallet                   */
/* -------------------------------------------------------------------------- */

const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * Create a new nonce row for `walletAddress`. The nonce is URL-safe,
 * 256 bits of entropy, single-use, and expires in 5 minutes.
 */
export async function createNonce(walletAddress: string): Promise<Nonce> {
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  const result = await query<NonceRow>(
    `INSERT INTO protocol_auth_sessions (nonce, wallet_address, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, nonce, wallet_address, issued_at, expires_at`,
    [nonce, walletAddress, expiresAt],
  );

  const row = result.rows[0];
  return {
    id: row.id,
    nonce: row.nonce,
    walletAddress: row.wallet_address,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  consumeNonce — single atomic UPDATE (Klaus R17)                           */
/* -------------------------------------------------------------------------- */

/**
 * Atomically consume a nonce. Returns the consumed row iff the nonce
 * existed, was not expired, and was not already consumed. Returns null
 * otherwise.
 *
 * Uses a single `UPDATE ... RETURNING` so two parallel /v1/auth/verify
 * calls with the same nonce see exactly one 200 and one 409 — no
 * SELECT-then-UPDATE race window. Klaus R17.
 */
export async function consumeNonce(
  nonce: string,
): Promise<ConsumedNonce | null> {
  const result = await query<ConsumedNonceRow>(
    `UPDATE protocol_auth_sessions
        SET consumed_at = NOW()
      WHERE nonce = $1
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING id, wallet_address`,
    [nonce],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    id: result.rows[0].id,
    walletAddress: result.rows[0].wallet_address,
  };
}

/* -------------------------------------------------------------------------- */
/*  JWT jti binding / revocation                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bind a JWT jti to a consumed auth session row. Called by
 * /v1/auth/verify after issuing the JWT so the jti can be revoked on
 * logout.
 *
 * Defence-in-depth: the UPDATE guards on `jwt_jti IS NULL` so a second
 * bind on the same session row is a no-op instead of silently
 * overwriting the first jti. Returns `true` if a row was bound,
 * `false` if the session row was already bound (or doesn't exist).
 * /v1/auth/verify treats a `false` return as a replay attempt.
 */
export async function bindJtiToSession(
  sessionId: string,
  jti: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE protocol_auth_sessions
        SET jwt_jti = $1
      WHERE id = $2
        AND jwt_jti IS NULL`,
    [jti, sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Returns true if the jti has been revoked (logout, admin revoke, …).
 * Backs the `requireBearerAuth` middleware revocation check via
 * `setJtiRevocationCheck`.
 */
export async function isJtiRevoked(jti: string): Promise<boolean> {
  const result = await query<{ one: number }>(
    `SELECT 1 AS one
       FROM protocol_auth_sessions
      WHERE jwt_jti = $1
        AND revoked_at IS NOT NULL
      LIMIT 1`,
    [jti],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke a jti (logout). Idempotent: calling it twice is safe, only
 * the first call flips `revoked_at`.
 */
export async function revokeJti(jti: string): Promise<void> {
  await query(
    `UPDATE protocol_auth_sessions
        SET revoked_at = NOW()
      WHERE jwt_jti = $1
        AND revoked_at IS NULL`,
    [jti],
  );
}

/* -------------------------------------------------------------------------- */
/*  Wiring — inject production revocation check into requireBearerAuth       */
/* -------------------------------------------------------------------------- */

/**
 * Wire this service's `isJtiRevoked` into the `requireBearerAuth`
 * middleware. Call once at server startup (before routes are
 * registered) so bearer-authed requests consult the real DB.
 */
export function wireAuthSessionRevocation(): void {
  setJtiRevocationCheck(isJtiRevoked);
}
