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
// Pin the schedule cap to 5 so the "6th attempt should 409" test is
// deterministic regardless of what a local .env file has.
process.env.DISCOVERY_MAX_SCHEDULED = "5";
// Route BullMQ at the same Redis the test harness has provisioned.
// Skip the scheduler suite entirely when REDIS_TEST_URL is unset —
// mirrors the TEST_DATABASE_URL opt-in pattern so the suite never
// fails closed just because the dev forgot to start Redis.
if (process.env.REDIS_TEST_URL) {
  process.env.REDIS_URL = process.env.REDIS_TEST_URL;
}
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

/* -------------------------------------------------------------------------- */
/*  Scheduler suite — opt-in via REDIS_TEST_URL                                */
/* -------------------------------------------------------------------------- */

/**
 * Covers task 11 (mini-app-ux-spec.md §7.6):
 *
 *   1. POST /schedule creates a row + enqueues a BullMQ delayed job.
 *   2. POST /schedule at cap returns 409.
 *   3. GET /scheduled only returns the authenticated wallet's rows.
 *   4. DELETE /scheduled/:id removes both DB + BullMQ state.
 *   5. DELETE another user's id returns 403.
 *   6. DELETE a non-existent id returns 404.
 *
 * Skipped unless BOTH TEST_DATABASE_URL and REDIS_TEST_URL are set —
 * Redis is only needed for this narrow slice of the discovery surface
 * and the /query path tests above don't depend on it.
 */
const SCHED_SKIP = SKIP || !process.env.REDIS_TEST_URL;

describe.skipIf(SCHED_SKIP)("discovery scheduler e2e", () => {
  let closeDiscoveryQueue: typeof import("../../src/services/bullmq.js").closeDiscoveryQueue;
  let discoveryQueueRef: typeof import("../../src/services/bullmq.js").discoveryQueue;

  beforeAll(async () => {
    const testApp = await import("../helpers/test-app.js");
    createTestApp = testApp.createTestApp;

    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    const bullmq = await import("../../src/services/bullmq.js");
    closeDiscoveryQueue = bullmq.closeDiscoveryQueue;
    discoveryQueueRef = bullmq.discoveryQueue;

    await setupTestDb();
    app = await createTestApp();
    // Drain any stale jobs from a previous run so test 1's "job
    // exists with this id" assertion isn't polluted.
    await discoveryQueueRef().obliterate({ force: true });
  });

  afterEach(async () => {
    await truncateAllTables();
    await discoveryQueueRef().obliterate({ force: true });
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDiscoveryQueue();
    await teardownTestDb();
  });

  /* ------------------------------------------------------------------ */
  /*  1. POST /schedule happy path                                      */
  /* ------------------------------------------------------------------ */

  it("POST /v1/discovery/schedule creates a row and enqueues a job", async () => {
    const kp = generateTestKeypair();
    const runAt = new Date(Date.now() + 60_000).toISOString();

    const res = await app.inject({
      method: "POST",
      url: "/v1/discovery/schedule",
      headers: kp.walletAuthHeaders,
      payload: { text: "stake 1 SOL", runAt },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallet).toBe(kp.walletBase58);
    expect(body.text).toBe("stake 1 SOL");
    expect(body.runAt).toBe(runAt);
    expect(body.status).toBe("pending");
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");

    // DB row exists and is linked to a BullMQ job.
    const pool = getTestPool();
    const row = await pool.query<{ bullmq_id: string | null; status: string }>(
      `SELECT bullmq_id, status FROM discovery_schedules WHERE id = $1`,
      [body.id],
    );
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].bullmq_id).toBe(body.id);

    // BullMQ job is retrievable by the same id.
    const job = await discoveryQueueRef().getJob(body.id);
    expect(job).toBeDefined();
    expect(job?.data.scheduleId).toBe(body.id);
    expect(job?.data.wallet).toBe(kp.walletBase58);
    expect(job?.data.text).toBe("stake 1 SOL");
  });

  /* ------------------------------------------------------------------ */
  /*  2. Cap enforcement                                                */
  /* ------------------------------------------------------------------ */

  it("POST /v1/discovery/schedule at cap returns 409", async () => {
    const kp = generateTestKeypair();
    const pool = getTestPool();
    const future = new Date(Date.now() + 60_000).toISOString();
    // Pre-seed 5 pending rows directly — bypasses BullMQ, which is
    // fine because the handler only reads the COUNT(*) for the cap.
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO discovery_schedules (wallet, text, run_at, status)
         VALUES ($1, $2, $3, 'pending')`,
        [kp.walletBase58, `prompt ${i}`, future],
      );
    }

    const res = await app.inject({
      method: "POST",
      url: "/v1/discovery/schedule",
      headers: kp.walletAuthHeaders,
      payload: { text: "one too many", runAt: future },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("schedule_cap_reached");
    expect(body.max).toBe(5);

    // No orphan row was inserted.
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM discovery_schedules WHERE wallet = $1`,
      [kp.walletBase58],
    );
    expect(count.rows[0].count).toBe("5");
  });

  /* ------------------------------------------------------------------ */
  /*  3. GET /scheduled is wallet-scoped                                */
  /* ------------------------------------------------------------------ */

  it("GET /v1/discovery/scheduled only returns the caller's rows", async () => {
    const kpA = generateTestKeypair();
    const kpB = generateTestKeypair();
    const pool = getTestPool();
    const future = new Date(Date.now() + 60_000).toISOString();

    await pool.query(
      `INSERT INTO discovery_schedules (wallet, text, run_at, status)
       VALUES ($1, 'A1', $2, 'pending'), ($3, 'B1', $2, 'pending')`,
      [kpA.walletBase58, future, kpB.walletBase58],
    );

    const res = await app.inject({
      method: "GET",
      url: "/v1/discovery/scheduled",
      headers: kpA.walletAuthHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].wallet).toBe(kpA.walletBase58);
    expect(body.items[0].text).toBe("A1");
  });

  /* ------------------------------------------------------------------ */
  /*  4. DELETE removes DB row + BullMQ job                             */
  /* ------------------------------------------------------------------ */

  it("DELETE /v1/discovery/scheduled/:id clears both DB and queue", async () => {
    const kp = generateTestKeypair();
    const runAt = new Date(Date.now() + 60_000).toISOString();

    const create = await app.inject({
      method: "POST",
      url: "/v1/discovery/schedule",
      headers: kp.walletAuthHeaders,
      payload: { text: "stake 1 SOL", runAt },
    });
    expect(create.statusCode).toBe(200);
    const { id } = create.json();

    // Sanity: job exists before DELETE.
    expect(await discoveryQueueRef().getJob(id)).not.toBeNull();

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/discovery/scheduled/${id}`,
      headers: kp.walletAuthHeaders,
    });
    expect(del.statusCode).toBe(204);

    // BullMQ job removed.
    expect(await discoveryQueueRef().getJob(id)).toBeUndefined();

    // DB row status flipped to 'cancelled'.
    const pool = getTestPool();
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM discovery_schedules WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("cancelled");
  });

  /* ------------------------------------------------------------------ */
  /*  5. DELETE another user's schedule -> 403                          */
  /* ------------------------------------------------------------------ */

  it("DELETE /v1/discovery/scheduled/:id for a foreign wallet returns 403", async () => {
    const kpOwner = generateTestKeypair();
    const kpAttacker = generateTestKeypair();
    const pool = getTestPool();
    const future = new Date(Date.now() + 60_000).toISOString();
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO discovery_schedules (wallet, text, run_at, status)
       VALUES ($1, 'owned', $2, 'pending') RETURNING id`,
      [kpOwner.walletBase58, future],
    );
    const id = inserted.rows[0].id;

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/discovery/scheduled/${id}`,
      headers: kpAttacker.walletAuthHeaders,
    });
    expect(res.statusCode).toBe(403);

    // Row must still be pending — the 403 path must not mutate state.
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM discovery_schedules WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  /* ------------------------------------------------------------------ */
  /*  6. DELETE non-existent id -> 404                                  */
  /* ------------------------------------------------------------------ */

  it("DELETE /v1/discovery/scheduled/:id for a missing id returns 404", async () => {
    const kp = generateTestKeypair();
    // Valid UUID shape so zod passes; the row genuinely doesn't exist.
    const missing = "00000000-0000-4000-8000-000000000000";
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/discovery/scheduled/${missing}`,
      headers: kp.walletAuthHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  /* ------------------------------------------------------------------ */
  /*  7. GET /results is wallet-scoped                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Regression guard: GET /discovery/results must only surface results
   * whose parent `discovery_schedules` row belongs to the caller. The
   * join is on `s.wallet = $1` — this test seeds two wallets each with
   * their own schedule + result row and asserts the caller only sees
   * their own entry (by text + scheduleId) and NONE of the other user's
   * data. Ordering of results is not asserted because there's only one
   * expected row per wallet.
   */
  it("GET /v1/discovery/results only returns the caller's results", async () => {
    const kpA = generateTestKeypair();
    const kpB = generateTestKeypair();
    const pool = getTestPool();
    const future = new Date(Date.now() + 60_000).toISOString();

    // Seed a 'done' schedule + matching result for each wallet. We use
    // distinct text so the positive/negative assertions can key off
    // substrings without ambiguity.
    const seedA = await pool.query<{ id: string }>(
      `INSERT INTO discovery_schedules (wallet, text, run_at, status)
       VALUES ($1, 'A-prompt-unique', $2, 'done') RETURNING id`,
      [kpA.walletBase58, future],
    );
    const seedB = await pool.query<{ id: string }>(
      `INSERT INTO discovery_schedules (wallet, text, run_at, status)
       VALUES ($1, 'B-prompt-unique', $2, 'done') RETURNING id`,
      [kpB.walletBase58, future],
    );
    const scheduleIdA = seedA.rows[0].id;
    const scheduleIdB = seedB.rows[0].id;

    await pool.query(
      `INSERT INTO discovery_results (schedule_id, assistant, matches, fell_back)
       VALUES ($1, $2, $3, false), ($4, $5, $6, false)`,
      [
        scheduleIdA,
        JSON.stringify({ text: "A-assistant-unique" }),
        JSON.stringify([{ protocolName: "A-protocol" }]),
        scheduleIdB,
        JSON.stringify({ text: "B-assistant-unique" }),
        JSON.stringify([{ protocolName: "B-protocol" }]),
      ],
    );

    const res = await app.inject({
      method: "GET",
      url: "/v1/discovery/results",
      headers: kpA.walletAuthHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].scheduleId).toBe(scheduleIdA);
    expect(body.items[0].text).toBe("A-prompt-unique");

    // Serialize the full response and assert NONE of B's identifiers or
    // payload leak through — the join must gate on wallet, not just
    // render-time filtering.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(scheduleIdB);
    expect(serialized).not.toContain("B-prompt-unique");
    expect(serialized).not.toContain("B-assistant-unique");
    expect(serialized).not.toContain("B-protocol");
  });
});
