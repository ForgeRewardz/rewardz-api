/**
 * End-to-end HTTP integration tests for /v1/auth/{challenge,verify,logout}.
 *
 * Covers Phase 5 Session 3 plan task 39:
 *
 *   (a) Happy path: challenge → sign → verify → JWT with correct
 *       aud / iss / jti / exp claims.
 *   (b) Expired nonce: nonce forcibly aged past expires_at → 409.
 *   (c) Consumed nonce: second /verify with same nonce → 409.
 *   (d) Concurrent replay: two parallel /verify calls with the same
 *       nonce via `Promise.all` → exactly one 200 and one 409. This
 *       is the atomic UPDATE…RETURNING proof.
 *   (e) Malformed signed-message format (missing v1: prefix) → 400.
 *   (f) Token with wrong `iss` → 401 on a protected route.
 *   (g) Revoked jti: logout then reuse token → 401 "revoked".
 *   (h) Exact byte layout: `|` separators → 400, `v2:` prefix → 400.
 *   (i) /v1/auth/verify rate limit: 11th call from same IP → 429.
 *
 * Gated on TEST_DATABASE_URL via describe.skipIf — skips cleanly when
 * unset so `pnpm test` still passes on a dev box without a dedicated
 * Postgres. Follows the same dynamic-import-in-beforeAll harness
 * pattern used by leaderboards.e2e.test.ts.
 */

// -----------------------------------------------------------------------------
// Env setup MUST happen before any dynamic `import("src/*")` call below.
// src/config.ts validates with zod + process.exit at module load, so
// JWT_SECRET / INTERNAL_API_KEY must be present before buildApp() imports
// it. DATABASE_URL is pointed at the test DB so service-layer query()
// calls hit the same database the test harness migrated. ADMIN_WALLETS
// is set to a valid base58 pubkey so config.ts passes validation even
// though this suite doesn't exercise the admin gate directly.
// -----------------------------------------------------------------------------

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-auth-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-auth-e2e";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";

import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { PublicKey } from "@solana/web3.js";

type TestAppModule = typeof import("../helpers/test-app.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let createTestApp: TestAppModule["createTestApp"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

let app: Awaited<ReturnType<TestAppModule["createTestApp"]>>;

const SKIP = !process.env.TEST_DATABASE_URL;

/* -------------------------------------------------------------------------- */
/*  ed25519 test keypair helper                                               */
/* -------------------------------------------------------------------------- */

/**
 * Generate a fresh ed25519 keypair and expose:
 *   - `walletBase58`: the 32-byte public key rendered as a base58
 *     Solana pubkey (what the challenge/verify routes expect)
 *   - `sign(message)`: produce a base64-encoded 64-byte signature
 *     over the UTF-8 bytes of `message`, matching what the route
 *     handler verifies with `crypto.verify(null, …)`
 *
 * Uses Node's built-in ed25519 primitive — no tweetnacl dependency.
 */
function generateTestKeypair(): {
  walletBase58: string;
  privateKey: crypto.KeyObject;
  sign: (message: string) => string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  // Extract the raw 32-byte ed25519 public key from the SPKI DER
  // wrapper. SPKI for ed25519 is a fixed 44-byte prefix ([0..12]) +
  // the 32-byte raw key. We strip the 12-byte prefix to get the
  // Solana-compatible pubkey bytes.
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPubKey = spkiDer.subarray(spkiDer.length - 32);
  const walletBase58 = new PublicKey(rawPubKey).toBase58();

  return {
    walletBase58,
    privateKey,
    sign: (message: string) =>
      crypto
        .sign(null, Buffer.from(message, "utf8"), privateKey)
        .toString("base64"),
  };
}

/* -------------------------------------------------------------------------- */
/*  Canonical signed-message builder — mirrors routes/auth.ts exactly         */
/* -------------------------------------------------------------------------- */

const US = "\u001f";
const AUTH_DOMAIN = "rewardz.xyz";
const V1_PREFIX = "v1:REWARDZ";

function buildCanonicalMessage(
  nonce: string,
  wallet: string,
  timestamp: string,
): string {
  return `${V1_PREFIX}${US}${AUTH_DOMAIN}${US}${nonce}${US}${wallet}${US}${timestamp}`;
}

/* -------------------------------------------------------------------------- */
/*  Flow helper: challenge → sign → verify                                    */
/* -------------------------------------------------------------------------- */

async function doChallenge(
  wallet: string,
  remoteAddress?: string,
): Promise<{
  nonce: string;
  message: string;
  expiresAt: string;
}> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/challenge",
    payload: { wallet },
    ...(remoteAddress ? { remoteAddress } : {}),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function doVerify(args: {
  wallet: string;
  nonce: string;
  message: string;
  signature: string;
  remoteAddress?: string;
}) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: {
      wallet: args.wallet,
      nonce: args.nonce,
      message: args.message,
      signature: args.signature,
    },
    ...(args.remoteAddress ? { remoteAddress: args.remoteAddress } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                     */
/* -------------------------------------------------------------------------- */

describe.skipIf(SKIP)("auth routes e2e", () => {
  beforeAll(async () => {
    // Dynamic imports AFTER env vars are set. ESM hoists static imports
    // above process.env.* assignments at the top of the file, but
    // dynamic imports inside a hook run after.
    const testApp = await import("../helpers/test-app.js");
    createTestApp = testApp.createTestApp;

    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    await setupTestDb();
    app = await createTestApp();
  });

  afterEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDb();
  });

  /* ------------------------------------------------------------------ */
  /*  (a) Happy path                                                    */
  /* ------------------------------------------------------------------ */

  it("(a) happy path: challenge → sign → verify returns a valid JWT", async () => {
    const ip = "198.51.100.10";
    const kp = generateTestKeypair();

    const challenge = await doChallenge(kp.walletBase58, ip);
    expect(typeof challenge.nonce).toBe("string");
    expect(challenge.message.startsWith(`${V1_PREFIX}${US}`)).toBe(true);
    // Exact byte layout: 5 fields separated by \u001f
    expect(challenge.message.split(US)).toHaveLength(5);

    const signature = kp.sign(challenge.message);
    const verifyRes = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: challenge.message,
      signature,
      remoteAddress: ip,
    });

    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(typeof body.token).toBe("string");
    expect(typeof body.jti).toBe("string");
    expect(typeof body.expiresAt).toBe("string");

    // Decode (without verifying) to inspect the claims shape.
    const decoded = jwt.decode(body.token, { complete: true });
    expect(decoded).not.toBeNull();
    const payload = (decoded as { payload: Record<string, unknown> }).payload;
    expect(payload.wallet_address).toBe(kp.walletBase58);
    expect(payload.aud).toBe("rewardz-api");
    expect(payload.iss).toBe("rewardz-console");
    expect(typeof payload.jti).toBe("string");
    expect(payload.jti).toBe(body.jti);
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.iat).toBe("number");
    // 15 minute expiry per signProtocolSessionJWT
    expect((payload.exp as number) - (payload.iat as number)).toBe(15 * 60);

    // Session row should be consumed + jwt_jti bound.
    const pool = getTestPool();
    const row = await pool.query<{
      consumed_at: Date | null;
      jwt_jti: string | null;
    }>(
      `SELECT consumed_at, jwt_jti FROM protocol_auth_sessions WHERE nonce = $1`,
      [challenge.nonce],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].consumed_at).not.toBeNull();
    expect(row.rows[0].jwt_jti).toBe(body.jti);
  });

  /* ------------------------------------------------------------------ */
  /*  (b) Expired nonce                                                 */
  /* ------------------------------------------------------------------ */

  it("(b) expired nonce → 409", async () => {
    const ip = "198.51.100.20";
    const kp = generateTestKeypair();
    const challenge = await doChallenge(kp.walletBase58, ip);

    // Force the row past its expiry window without waiting 5 minutes.
    const pool = getTestPool();
    await pool.query(
      `UPDATE protocol_auth_sessions
          SET expires_at = NOW() - INTERVAL '1 hour'
        WHERE nonce = $1`,
      [challenge.nonce],
    );

    const signature = kp.sign(challenge.message);
    const res = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: challenge.message,
      signature,
      remoteAddress: ip,
    });

    // consumeNonce() returns null for expired rows (the UPDATE
    // guards on `expires_at > NOW()`), which the route maps to 409.
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("Conflict");
  });

  /* ------------------------------------------------------------------ */
  /*  (c) Consumed nonce                                                */
  /* ------------------------------------------------------------------ */

  it("(c) consumed nonce → second verify 409", async () => {
    const ip = "198.51.100.30";
    const kp = generateTestKeypair();
    const challenge = await doChallenge(kp.walletBase58, ip);
    const signature = kp.sign(challenge.message);

    const first = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: challenge.message,
      signature,
      remoteAddress: ip,
    });
    expect(first.statusCode).toBe(200);

    const second = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: challenge.message,
      signature,
      remoteAddress: ip,
    });
    expect(second.statusCode).toBe(409);
  });

  /* ------------------------------------------------------------------ */
  /*  (d) Concurrent replay — atomic consume proof                      */
  /* ------------------------------------------------------------------ */

  it("(d) two parallel /verify calls with same nonce → exactly one 200 and one 409", async () => {
    const kp = generateTestKeypair();
    const challenge = await doChallenge(kp.walletBase58, "198.51.100.40");
    const signature = kp.sign(challenge.message);

    const payload = {
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: challenge.message,
      signature,
    };

    // Fire both requests as close together as possible. Two separate
    // remoteAddresses so the rate limiter (10/min/IP) doesn't steal
    // the 2nd one on a bucket carry-over from a prior test.
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload,
        remoteAddress: "10.0.0.1",
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload,
        remoteAddress: "10.0.0.2",
      }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
  });

  /* ------------------------------------------------------------------ */
  /*  (e) Malformed signed-message format — missing v1: prefix          */
  /* ------------------------------------------------------------------ */

  it("(e) malformed signed message (no v1: prefix) → 400", async () => {
    const ip = "198.51.100.50";
    const kp = generateTestKeypair();
    const challenge = await doChallenge(kp.walletBase58, ip);
    // Fabricate a message that lacks the mandatory v1:REWARDZ prefix.
    const badMessage = `REWARDZ${US}${AUTH_DOMAIN}${US}${challenge.nonce}${US}${kp.walletBase58}${US}${new Date().toISOString()}`;
    const signature = kp.sign(badMessage);

    const res = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: badMessage,
      signature,
      remoteAddress: ip,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Bad Request");
  });

  /* ------------------------------------------------------------------ */
  /*  (f) Protected route with wrong iss → 401                          */
  /* ------------------------------------------------------------------ */

  it("(f) bearer token with wrong iss → 401 on protected route", async () => {
    // Seed a real protocol so the eventual 401 can't be masked by a 404
    // (requireProtocolOwner looks the row up before the ownership
    // check — but the upstream requireBearerAuth rejects earlier).
    const pool = getTestPool();
    const protocolId = "00000000-0000-0000-0000-00000000a001";
    await pool.query(
      `INSERT INTO protocols (id, admin_wallet, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [protocolId, "some-wallet", "Bad Iss Probe"],
    );

    // Mint a token with a bogus issuer but the right secret / audience.
    // jwt.verify() in requireBearerAuth will fail the issuer check.
    const token = jwt.sign(
      { wallet_address: "some-wallet" },
      process.env.JWT_SECRET as string,
      {
        expiresIn: 900,
        jwtid: "bogus-jti",
        audience: "rewardz-api",
        issuer: "not-rewardz-console",
      },
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/protocols/${protocolId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "should-not-land" },
    });

    expect(res.statusCode).toBe(401);

    // Also test wrong `aud`.
    const wrongAudToken = jwt.sign(
      { wallet_address: "some-wallet" },
      process.env.JWT_SECRET as string,
      {
        expiresIn: 900,
        jwtid: "bogus-jti-2",
        audience: "not-rewardz-api",
        issuer: "rewardz-console",
      },
    );
    const res2 = await app.inject({
      method: "PATCH",
      url: `/v1/protocols/${protocolId}`,
      headers: { authorization: `Bearer ${wrongAudToken}` },
      payload: { name: "should-not-land" },
    });
    expect(res2.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------------ */
  /*  (g) Revoked jti — logout then retry                               */
  /* ------------------------------------------------------------------ */

  it("(g) revoked jti → 401 on protected route after /auth/logout", async () => {
    const ip = "198.51.100.70";
    const kp = generateTestKeypair();

    // Seed a protocol owned by the test wallet so requireProtocolOwner
    // wouldn't 403 if the token were valid. We want to prove the 401
    // comes from the revocation check, not from ownership.
    const pool = getTestPool();
    const protocolId = "00000000-0000-0000-0000-00000000b001";
    await pool.query(
      `INSERT INTO protocols (id, admin_wallet, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [protocolId, kp.walletBase58, "Revoke Probe"],
    );

    // 1. challenge + verify to get a real token.
    const challenge = await doChallenge(kp.walletBase58, ip);
    const signature = kp.sign(challenge.message);
    const verifyRes = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: challenge.message,
      signature,
      remoteAddress: ip,
    });
    expect(verifyRes.statusCode).toBe(200);
    const { token } = verifyRes.json() as { token: string };

    // 2. Happy path: token works on a protected route first.
    const okRes = await app.inject({
      method: "PATCH",
      url: `/v1/protocols/${protocolId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "updated once" },
    });
    expect(okRes.statusCode).toBe(200);

    // 3. Logout revokes the jti.
    const logoutRes = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json()).toEqual({ revoked: true });

    // 4. Reuse the same token → 401 via the isJtiRevoked check.
    const retryRes = await app.inject({
      method: "PATCH",
      url: `/v1/protocols/${protocolId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "should be rejected" },
    });
    expect(retryRes.statusCode).toBe(401);
    const body = retryRes.json();
    expect(body.message).toMatch(/revoked/i);

    // 5. Logout is idempotent — re-posting with the same token still
    //    gets past requireBearerAuth's revocation check? No — the
    //    already-revoked token would 401 before hitting the logout
    //    handler. That's the correct behaviour (you can't logout
    //    twice from the same token); we just assert the system stays
    //    consistent.
    const repeatLogout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(repeatLogout.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------------ */
  /*  (h) Exact byte layout — wrong separators / wrong version prefix   */
  /* ------------------------------------------------------------------ */

  it("(h) exact byte layout — `|` separators → 400, `v2:` prefix → 400", async () => {
    const ip = "198.51.100.80";
    const kp = generateTestKeypair();
    const challenge = await doChallenge(kp.walletBase58, ip);
    const timestamp = new Date().toISOString();

    // Case 1: pipe-delimited (structurally the right fields, wrong bytes).
    const pipeMessage = `${V1_PREFIX}|${AUTH_DOMAIN}|${challenge.nonce}|${kp.walletBase58}|${timestamp}`;
    const pipeSig = kp.sign(pipeMessage);
    const pipeRes = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: pipeMessage,
      signature: pipeSig,
      remoteAddress: ip,
    });
    expect(pipeRes.statusCode).toBe(400);

    // Case 2: v2: prefix (forwards-incompatible future version).
    const v2Message = `v2:REWARDZ${US}${AUTH_DOMAIN}${US}${challenge.nonce}${US}${kp.walletBase58}${US}${timestamp}`;
    const v2Sig = kp.sign(v2Message);
    const v2Res = await doVerify({
      wallet: kp.walletBase58,
      nonce: challenge.nonce,
      message: v2Message,
      signature: v2Sig,
      remoteAddress: ip,
    });
    expect(v2Res.statusCode).toBe(400);
  });

  /* ------------------------------------------------------------------ */
  /*  (i) /v1/auth/verify rate limit — 11th req from same IP → 429      */
  /* ------------------------------------------------------------------ */

  it("(i) /v1/auth/verify rate-limited at 10/min/IP (11th → 429)", async () => {
    // Fire 11 /verify requests from the same simulated IP. Payloads are
    // intentionally malformed (missing body) so each request returns 400
    // cheaply without touching the DB. The rate-limit preHandler runs
    // BEFORE the zod body parse, so a 400 still consumes a token.
    const ip = "203.0.113.99";
    const codes: number[] = [];

    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        remoteAddress: ip,
        payload: {
          wallet: "not-a-real-wallet",
          nonce: "x",
          message: "x",
          signature: "x",
        },
      });
      codes.push(res.statusCode);
    }

    // First 10 are 400 (bad wallet / bad message — not 429); 11th is 429.
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
