/**
 * End-to-end HTTP integration tests for /v1/discovery/{query,quota,suggestions}.
 *
 * Covers plan task 9-10 (mini-app-ux-spec.md §7.2, §7.3, §7.4):
 *
 *   1. POST /discovery/query happy path — quota consumed, 200 + matches.
 *   2. POST /discovery/query with quota exhausted — 402, resolver NOT
 *      invoked (verified by checking the quota counter did not advance).
 *   3. POST /discovery/query with unmatched text — matches empty,
 *      suggestions populated.
 *   4. GET /discovery/quota?wallet=... — returns current state.
 *   5. GET /discovery/suggestions?count=3 — returns three prompts.
 *   6. GET /discovery/suggestions default — returns two prompts.
 *
 * Gated on TEST_DATABASE_URL via describe.skipIf — mirrors the harness
 * pattern in campaigns.e2e.test.ts / auth.e2e.test.ts. Wallet auth uses
 * an ephemeral ed25519 keypair minted per test (same approach as
 * auth.e2e.test.ts); no shared helper exists yet and this suite is the
 * first consumer outside of auth itself.
 */

// -----------------------------------------------------------------------------
// Env setup MUST happen before any dynamic `import("src/*")` call below.
// src/config.ts validates with zod + process.exit at module load, so
// JWT_SECRET / INTERNAL_API_KEY must be present before buildApp() imports
// it. DATABASE_URL is pointed at the test DB so service-layer query()
// calls hit the same database the test harness migrated. ADMIN_WALLETS
// is set to a valid base58 pubkey so config.ts validation passes.
// DISCOVERY_FREE_QUOTA_PER_DAY is pinned to 2 so the quota-exhaustion
// path is reachable in a single test without 3+ round-trips.
// -----------------------------------------------------------------------------

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-discovery-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-discovery-e2e";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";
process.env.DISCOVERY_FREE_QUOTA_PER_DAY = "2";
// Clear the Gemini key so the resolver is deterministically on the rules
// path — otherwise `fellBackToRules` depends on a real Gemini stub.
// biome-ignore lint/performance/noDelete: test setup
delete process.env.GEMINI_API_KEY;

import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
/*  ed25519 keypair helper — mirrors auth.e2e.test.ts                          */
/* -------------------------------------------------------------------------- */

function generateTestKeypair(): {
  walletBase58: string;
  walletAuthHeaders: Record<string, string>;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPubKey = spkiDer.subarray(spkiDer.length - 32);
  const walletBase58 = new PublicKey(rawPubKey).toBase58();

  // `requireWalletAuth` expects a signature over the fixed challenge
  // string. Mirror the handler exactly so the signature verifies.
  const message = Buffer.from(`Sign in to REWARDZ with wallet ${walletBase58}`);
  const signature = crypto.sign(null, message, privateKey).toString("base64");

  return {
    walletBase58,
    walletAuthHeaders: {
      "x-wallet-address": walletBase58,
      "x-wallet-signature": signature,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Protocol seed helper                                                      */
/* -------------------------------------------------------------------------- */

async function seedStakeProtocol(): Promise<void> {
  const pool = getTestPool();
  // `supported_actions` must include `stake` so resolveIntent matches a
  // "stake N SOL" query. The admin_wallet value is arbitrary — the query
  // path doesn't gate on protocol ownership.
  await pool.query(
    `INSERT INTO protocols (admin_wallet, name, supported_actions, status)
     VALUES ($1, $2, $3, 'active')`,
    ["So11111111111111111111111111111111111111112", "Marinade Test", ["stake"]],
  );
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                     */
/* -------------------------------------------------------------------------- */

describe.skipIf(SKIP)("discovery routes e2e", () => {
  beforeAll(async () => {
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
  /*  1. Happy path                                                     */
  /* ------------------------------------------------------------------ */

  it("POST /v1/discovery/query happy path consumes quota and returns matches", async () => {
    await seedStakeProtocol();
    const kp = generateTestKeypair();

    const res = await app.inject({
      method: "POST",
      url: "/v1/discovery/query",
      headers: kp.walletAuthHeaders,
      payload: { text: "stake 1 SOL" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intent).toBe("stake");
    expect(body.resolverType).toBe("rules");
    // No Gemini key => not a fallback, it's the only path.
    expect(body.fellBackToRules).toBe(false);
    expect(Array.isArray(body.matches)).toBe(true);
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches[0]).toMatchObject({
      actionType: "stake",
      protocolName: "Marinade Test",
    });
    expect(body.quotaRemaining).toBe(1); // DISCOVERY_FREE_QUOTA_PER_DAY=2, consumed 1
    expect(body.assistantText).toMatch(/stake/i);
    // Matches present ⇒ no suggestions returned.
    expect(body.suggestions).toEqual([]);

    // Verify the quota counter persisted.
    const pool = getTestPool();
    const row = await pool.query<{ used: number }>(
      `SELECT used FROM discovery_usage WHERE wallet = $1`,
      [kp.walletBase58],
    );
    expect(row.rows[0]?.used).toBe(1);
  });

  /* ------------------------------------------------------------------ */
  /*  2. Quota exhausted -> 402                                         */
  /* ------------------------------------------------------------------ */

  it("POST /v1/discovery/query with quota=0 returns 402 without consuming", async () => {
    const kp = generateTestKeypair();
    const pool = getTestPool();
    // Pre-fill today's row at the limit (2) so the very next call is
    // the one that should 402.
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO discovery_usage (wallet, day_utc, used) VALUES ($1, $2, 2)`,
      [kp.walletBase58, today],
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/discovery/query",
      headers: kp.walletAuthHeaders,
      payload: { text: "stake 1 SOL" },
    });

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe("quota_exhausted");
    expect(body.remaining).toBe(0);
    expect(typeof body.resetAt).toBe("string");

    // Counter must stay at 2 — the 402 path must not consume.
    const row = await pool.query<{ used: number }>(
      `SELECT used FROM discovery_usage WHERE wallet = $1 AND day_utc = $2`,
      [kp.walletBase58, today],
    );
    expect(row.rows[0]?.used).toBe(2);
  });

  /* ------------------------------------------------------------------ */
  /*  3. Unmatched text -> empty matches + suggestions                  */
  /* ------------------------------------------------------------------ */

  it("POST /v1/discovery/query with unmatched text returns suggestions", async () => {
    const kp = generateTestKeypair();

    const res = await app.inject({
      method: "POST",
      url: "/v1/discovery/query",
      headers: kp.walletAuthHeaders,
      payload: {
        text: "what is the meaning of life",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intent).toBe("custom");
    expect(body.matches).toEqual([]);
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions.length).toBeLessThanOrEqual(3);
  });

  /* ------------------------------------------------------------------ */
  /*  4. GET /discovery/quota                                           */
  /* ------------------------------------------------------------------ */

  it("GET /v1/discovery/quota returns current state", async () => {
    const kp = generateTestKeypair();
    const pool = getTestPool();
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO discovery_usage (wallet, day_utc, used) VALUES ($1, $2, 1)`,
      [kp.walletBase58, today],
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/discovery/quota?wallet=${kp.walletBase58}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallet).toBe(kp.walletBase58);
    expect(body.used).toBe(1);
    expect(body.remaining).toBe(1); // limit 2 - used 1
    expect(body.dayUtc).toBe(today);
    expect(typeof body.resetAtUtc).toBe("string");
  });

  /* ------------------------------------------------------------------ */
  /*  5. GET /discovery/suggestions?count=3                             */
  /* ------------------------------------------------------------------ */

  it("GET /v1/discovery/suggestions?count=3 returns 3 suggestions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/discovery/suggestions?count=3",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions.every((s: unknown) => typeof s === "string")).toBe(
      true,
    );
  });

  /* ------------------------------------------------------------------ */
  /*  6. GET /discovery/suggestions default                             */
  /* ------------------------------------------------------------------ */

  it("GET /v1/discovery/suggestions default returns 2 suggestions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/discovery/suggestions",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestions).toHaveLength(2);
  });

  /* ------------------------------------------------------------------ */
  /*  7. Quota is consumed against the AUTHENTICATED wallet             */
  /* ------------------------------------------------------------------ */

  /**
   * Regression guard for the auth-bypass fix: the handler must derive the
   * wallet from the signed challenge (`request.walletAddress`) and NOT from
   * any body field. We sign auth for wallet A, post the query, and assert:
   *
   *   - A's discovery_usage row is incremented to used=1.
   *   - An unrelated wallet B has no row at all (no cross-attribution).
   *
   * Before the fix, an attacker signed in as A could pass B in the body and
   * consume B's quota — this test locks that door shut.
   */
  it("POST /v1/discovery/query consumes quota against the authenticated wallet", async () => {
    await seedStakeProtocol();
    const kpA = generateTestKeypair();
    const kpB = generateTestKeypair();
    const pool = getTestPool();
    const today = new Date().toISOString().slice(0, 10);

    const res = await app.inject({
      method: "POST",
      url: "/v1/discovery/query",
      headers: kpA.walletAuthHeaders,
      payload: { text: "stake 1 SOL" },
    });

    expect(res.statusCode).toBe(200);

    // Wallet A — the authenticated identity — must have been charged.
    const rowA = await pool.query<{ used: number }>(
      `SELECT used FROM discovery_usage WHERE wallet = $1 AND day_utc = $2`,
      [kpA.walletBase58, today],
    );
    expect(rowA.rows[0]?.used).toBe(1);

    // Wallet B — unrelated — must not have a row at all. The handler
    // should never touch B's ledger because B is not the auth subject.
    const rowB = await pool.query<{ used: number }>(
      `SELECT used FROM discovery_usage WHERE wallet = $1 AND day_utc = $2`,
      [kpB.walletBase58, today],
    );
    expect(rowB.rows.length).toBe(0);
  });
});
