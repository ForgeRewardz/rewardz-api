/**
 * Regression test for the batchAward mid-batch throw / rollback bug.
 *
 * See task 14a in the Phase 5 Session 2 plan. Before the fix, items pushed
 * to `results[]` as `success: true` before a mid-batch throw were never
 * re-marked after the tx rolled back, so callers saw phantom successes
 * for awards that never actually landed in the database.
 *
 * This test locks down the invariant: if ANY item in a batch throws, the
 * returned BatchResult must report `succeeded: 0, duplicates: 0,
 * failed: N` AND the database must contain zero point_event rows, zero
 * protocol_scores deltas, and zero user_season_scores deltas for every
 * wallet in the batch.
 *
 * Gated on `TEST_DATABASE_URL` — skips cleanly when unset so `pnpm test`
 * still passes on a developer box without a dedicated test Postgres.
 */

// Align the production pool (points-service reads from `db/client.ts`
// which hits `config.DATABASE_URL`) with the test DB before importing
// anything from `src/`. When `TEST_DATABASE_URL` is unset the whole
// suite is skipped, so the fallback just preserves the existing env.
//
// `config.ts` also validates JWT_SECRET / INTERNAL_API_KEY at import
// time via zod + process.exit — inject safe test defaults here so the
// transitive import chain succeeds even when the developer hasn't
// exported them in their shell. ESM hoists static imports above this
// block, so we use `await import(...)` inside `beforeAll` to defer
// module load until after env setup.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-batch-award-rollback";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-batch-award-rollback";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type BatchAwardFn = typeof import("../../src/services/points-service.js")["batchAward"];
type TestDbModule = typeof import("../helpers/test-db.js");

let batchAward: BatchAwardFn;
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

const SKIP = !process.env.TEST_DATABASE_URL;

const TEST_PROTOCOL_ID = "00000000-0000-0000-0000-000000000abc";
const TEST_SEASON_ID = "00000000-0000-0000-0000-000000000def";
const BAD_PROTOCOL_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

async function seedFixtures(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_PROTOCOL_ID, "admin-wallet-rollback-test", "Rollback Test Protocol"],
  );
  await pool.query(
    `INSERT INTO leaderboard_seasons (id, name, start_at, is_active)
     VALUES ($1, $2, NOW(), TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_SEASON_ID, "Rollback Regression Season"],
  );
}

describe.skipIf(SKIP)("batchAward rollback regression", () => {
  beforeAll(async () => {
    // Defer module loading until AFTER env vars are configured —
    // `config.ts` validates with zod + process.exit at import time,
    // and ESM hoists static imports above our env-setup block.
    const pointsService = await import("../../src/services/points-service.js");
    batchAward = pointsService.batchAward;
    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    await setupTestDb();
    await truncateAllTables();
    await seedFixtures();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await seedFixtures();
  });

  it("commits every item when the whole batch succeeds", async () => {
    const pool = getTestPool();

    const result = await batchAward([
      {
        wallet: "wallet-a",
        amount: 100n,
        protocolId: TEST_PROTOCOL_ID,
        idempotencyKey: "happy-path-1",
        channel: "api",
      },
      {
        wallet: "wallet-b",
        amount: 200n,
        protocolId: TEST_PROTOCOL_ID,
        idempotencyKey: "happy-path-2",
        channel: "api",
      },
      {
        wallet: "wallet-c",
        amount: 300n,
        protocolId: TEST_PROTOCOL_ID,
        idempotencyKey: "happy-path-3",
        channel: "api",
      },
    ]);

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.failed).toBe(0);

    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM point_events`,
    );
    expect(events.rows[0].count).toBe("3");

    const pscore = await pool.query<{ total_points_issued: string }>(
      `SELECT total_points_issued::text AS total_points_issued
         FROM protocol_scores
        WHERE season_id = $1 AND protocol_id = $2`,
      [TEST_SEASON_ID, TEST_PROTOCOL_ID],
    );
    expect(pscore.rows[0].total_points_issued).toBe("600");

    const uscores = await pool.query<{
      user_wallet: string;
      total_points: string;
    }>(
      `SELECT user_wallet, total_points::text AS total_points
         FROM user_season_scores
        WHERE season_id = $1
        ORDER BY user_wallet`,
      [TEST_SEASON_ID],
    );
    expect(uscores.rowCount).toBe(3);
    expect(uscores.rows.find((r) => r.user_wallet === "wallet-a")?.total_points).toBe(
      "100",
    );
    expect(uscores.rows.find((r) => r.user_wallet === "wallet-b")?.total_points).toBe(
      "200",
    );
    expect(uscores.rows.find((r) => r.user_wallet === "wallet-c")?.total_points).toBe(
      "300",
    );
  });

  it("rolls everything back + zeroes counters when the middle item throws", async () => {
    const pool = getTestPool();

    const result = await batchAward([
      {
        wallet: "wallet-x",
        amount: 100n,
        protocolId: TEST_PROTOCOL_ID,
        idempotencyKey: "rollback-first",
        channel: "api",
      },
      {
        // Middle item has a protocol_id that violates the FK to protocols.id,
        // which is exactly the mid-batch throw condition the 14a fix
        // exists to handle.
        wallet: "wallet-y",
        amount: 200n,
        protocolId: BAD_PROTOCOL_ID,
        idempotencyKey: "rollback-middle",
        channel: "api",
      },
      {
        wallet: "wallet-z",
        amount: 300n,
        protocolId: TEST_PROTOCOL_ID,
        idempotencyKey: "rollback-last",
        channel: "api",
      },
    ]);

    // Counter invariants from task 14a:
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.failed).toBe(3);

    // Every result entry should now be success: false.
    for (const item of result.results) {
      expect(item.success).toBe(false);
      expect(item.error).toBeDefined();
    }

    // Database invariants: nothing landed.
    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM point_events`,
    );
    expect(events.rows[0].count).toBe("0");

    const pscoreCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM protocol_scores`,
    );
    expect(pscoreCount.rows[0].count).toBe("0");

    const uscoreCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_season_scores`,
    );
    expect(uscoreCount.rows[0].count).toBe("0");
  });
});
