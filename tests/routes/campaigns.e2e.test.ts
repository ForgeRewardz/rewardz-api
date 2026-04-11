/**
 * End-to-end HTTP integration tests for /v1/protocols/:id/campaigns.
 *
 * Covers Phase 5 Session 3 plan task 43:
 *
 *   1. Unauthenticated POST -> 401
 *   2. Wrong-protocol-owner JWT -> 403 (cross-protocol 403 from plan
 *      v2 criterion #10)
 *   3. Happy-path create -> 201 with status='draft'
 *   4. Update draft -> live -> 200
 *   5. Illegal transition completed -> live -> 400
 *   6. List with ?status=live filter returns only live campaigns
 *   7. Stats endpoint returns completion_count and points_issued
 *      computed from point_events
 *
 * Gated on `TEST_DATABASE_URL` via describe.skipIf — skips cleanly
 * when unset so `pnpm test` still passes on a dev box without a
 * dedicated Postgres. Mirrors leaderboards.e2e.test.ts harness
 * pattern (env setup above dynamic imports, helper imports inside
 * beforeAll).
 */

// -----------------------------------------------------------------------------
// Env setup MUST happen before any dynamic `import("src/*")` call below.
// src/config.ts validates with zod + process.exit at module load, so
// JWT_SECRET / INTERNAL_API_KEY must be present before buildApp() imports
// it. DATABASE_URL is pointed at the test DB so service-layer query()
// calls hit the same database the test harness migrated. ADMIN_WALLETS
// is set to a valid base58 pubkey so config.ts validation passes even
// though this suite does not exercise the admin gate directly.
// -----------------------------------------------------------------------------

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-campaigns-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-campaigns-e2e";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

type TestAppModule = typeof import("../helpers/test-app.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let createTestApp: TestAppModule["createTestApp"];
let authHeader: TestAppModule["authHeader"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

let app: Awaited<ReturnType<TestAppModule["createTestApp"]>>;

const SKIP = !process.env.TEST_DATABASE_URL;

// Two distinct protocols so the cross-protocol 403 case has a real
// second wallet to contrast against.
const PROTOCOL_A = "00000000-0000-0000-0000-000000000a01";
const PROTOCOL_B = "00000000-0000-0000-0000-000000000a02";
const WALLET_A = "So11111111111111111111111111111111111111112"; // 44-char base58
const WALLET_B = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // real mint — still valid base58

const VALID_BODY = {
  title: "Swap Jupiter USDC -> SOL",
  description: "Onboarding swap campaign for airdrop season 1.",
  intent_type: "swap",
  action_url_template: "https://example.com/blinks/jupiter/swap",
  verification_adapter: "completion.generic.v1",
  reward_points: 120,
  eligibility: {
    min_amount_usd: 5,
    one_reward_per_wallet_per_day: true,
  },
  budget: {
    max_awards: 10000,
    max_total_points: 1200000,
  },
  start_at: "2026-04-10T00:00:00.000Z",
  end_at: "2026-05-10T00:00:00.000Z",
};

async function seedProtocolA(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status)
     VALUES ($1, $2, $3, 'active')`,
    [PROTOCOL_A, WALLET_A, "Protocol A"],
  );
}

async function seedProtocolB(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status)
     VALUES ($1, $2, $3, 'active')`,
    [PROTOCOL_B, WALLET_B, "Protocol B"],
  );
}

describe.skipIf(SKIP)("campaigns e2e", () => {
  beforeAll(async () => {
    const testApp = await import("../helpers/test-app.js");
    createTestApp = testApp.createTestApp;
    authHeader = testApp.authHeader;

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
  /*  1. Unauthenticated                                                */
  /* ------------------------------------------------------------------ */

  it("POST /v1/protocols/:id/campaigns without auth -> 401", async () => {
    await seedProtocolA();

    const res = await app.inject({
      method: "POST",
      url: `/v1/protocols/${PROTOCOL_A}/campaigns`,
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------------ */
  /*  2. Cross-protocol owner -> 403                                    */
  /* ------------------------------------------------------------------ */

  it("POST /v1/protocols/:B/campaigns by wallet A -> 403", async () => {
    await seedProtocolA();
    await seedProtocolB();

    const res = await app.inject({
      method: "POST",
      url: `/v1/protocols/${PROTOCOL_B}/campaigns`,
      headers: authHeader(WALLET_A),
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("Forbidden");
  });

  /* ------------------------------------------------------------------ */
  /*  3. Happy path create                                              */
  /* ------------------------------------------------------------------ */

  it("POST /v1/protocols/:id/campaigns happy path -> 201 draft", async () => {
    await seedProtocolA();

    const res = await app.inject({
      method: "POST",
      url: `/v1/protocols/${PROTOCOL_A}/campaigns`,
      headers: authHeader(WALLET_A),
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("draft");
    expect(body.protocolId).toBe(PROTOCOL_A);
    expect(body.title).toBe(VALID_BODY.title);
    expect(body.intent_type).toBe(VALID_BODY.intent_type);
    expect(body.action_url_template).toBe(VALID_BODY.action_url_template);
    expect(body.reward_points).toBe(VALID_BODY.reward_points);
    expect(body.eligibility).toEqual(VALID_BODY.eligibility);
    expect(body.budget).toEqual(VALID_BODY.budget);
    expect(typeof body.campaignId).toBe("string");
  });

  /* ------------------------------------------------------------------ */
  /*  4. Update draft -> live                                           */
  /* ------------------------------------------------------------------ */

  it("PUT /v1/protocols/:id/campaigns/:campaignId draft -> live -> 200", async () => {
    await seedProtocolA();

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/protocols/${PROTOCOL_A}/campaigns`,
      headers: authHeader(WALLET_A),
      payload: VALID_BODY,
    });
    expect(createRes.statusCode).toBe(201);
    const campaignId = createRes.json().campaignId;

    const updRes = await app.inject({
      method: "PUT",
      url: `/v1/protocols/${PROTOCOL_A}/campaigns/${campaignId}`,
      headers: authHeader(WALLET_A),
      payload: { status: "live" },
    });

    expect(updRes.statusCode).toBe(200);
    expect(updRes.json().status).toBe("live");
  });

  /* ------------------------------------------------------------------ */
  /*  5. Illegal transition completed -> live -> 400                    */
  /* ------------------------------------------------------------------ */

  it("PUT completed -> live -> 400 (illegal transition)", async () => {
    await seedProtocolA();

    // Insert a completed campaign directly so we don't have to walk
    // the full draft -> live -> completed state machine through the
    // route (which would exercise two legal transitions first).
    const pool = getTestPool();
    const insert = await pool.query<{ campaign_id: string }>(
      `INSERT INTO campaigns (protocol_id, name, action_type, points_per_completion, status)
       VALUES ($1, $2, $3, $4, 'completed')
       RETURNING campaign_id`,
      [PROTOCOL_A, "Pre-completed", "swap", 100],
    );
    const campaignId = insert.rows[0].campaign_id;

    const res = await app.inject({
      method: "PUT",
      url: `/v1/protocols/${PROTOCOL_A}/campaigns/${campaignId}`,
      headers: authHeader(WALLET_A),
      payload: { status: "live" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Bad Request");
    expect(body.message).toMatch(/Illegal status transition/);
  });

  /* ------------------------------------------------------------------ */
  /*  6. List with ?status=live filter                                  */
  /* ------------------------------------------------------------------ */

  it("GET /v1/protocols/:id/campaigns?status=live returns only live campaigns", async () => {
    await seedProtocolA();
    const pool = getTestPool();

    // Seed three campaigns in three distinct statuses.
    for (const [name, status] of [
      ["draft one", "draft"],
      ["live one", "live"],
      ["paused one", "paused"],
    ]) {
      await pool.query(
        `INSERT INTO campaigns (protocol_id, name, action_type, points_per_completion, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [PROTOCOL_A, name, "swap", 100, status],
      );
    }

    const res = await app.inject({
      method: "GET",
      url: `/v1/protocols/${PROTOCOL_A}/campaigns?status=live`,
      headers: authHeader(WALLET_A),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].title).toBe("live one");
    expect(body.entries[0].status).toBe("live");
  });

  /* ------------------------------------------------------------------ */
  /*  7. Stats endpoint                                                 */
  /* ------------------------------------------------------------------ */

  it("GET /v1/protocols/:id/campaigns/:campaignId/stats returns aggregates", async () => {
    await seedProtocolA();
    const pool = getTestPool();

    const insert = await pool.query<{ campaign_id: string }>(
      `INSERT INTO campaigns (protocol_id, name, action_type, points_per_completion, status, budget_total, budget_spent)
       VALUES ($1, $2, $3, $4, 'live', $5, $6)
       RETURNING campaign_id`,
      [PROTOCOL_A, "Stats campaign", "swap", 100, 1000, 250],
    );
    const campaignId = insert.rows[0].campaign_id;

    // Seed three point_events whose source_reference embeds the
    // campaign id so the stats aggregation picks them up (the
    // route matches with LIKE %campaignId%).
    for (const [wallet, amount] of [
      ["wallet-stats-1", 100],
      ["wallet-stats-2", 100],
      ["wallet-stats-3", 50],
    ]) {
      await pool.query(
        `INSERT INTO point_events (user_wallet, protocol_id, type, amount, source_reference, channel)
         VALUES ($1, $2, 'awarded', $3, $4, 'api')`,
        [wallet, PROTOCOL_A, amount, `campaign:${campaignId}:${wallet}`],
      );
    }

    const res = await app.inject({
      method: "GET",
      url: `/v1/protocols/${PROTOCOL_A}/campaigns/${campaignId}/stats`,
      headers: authHeader(WALLET_A),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaignId).toBe(campaignId);
    expect(body.completion_count).toBe(3);
    expect(body.points_issued).toBe("250");
    expect(body.unique_users).toBe(3);
    expect(body.budget_used).toBe("250");
    expect(body.budget_remaining).toBe("750");
  });
});
