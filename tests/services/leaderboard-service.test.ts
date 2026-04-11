/**
 * Unit tests for src/services/leaderboard-service.ts.
 *
 * Covers the 7 cases called out in Phase 5 Session 2 plan task 21:
 *   1. getActiveSeason returns null when no active season exists
 *   2. getActiveSeason returns the most recently started active season
 *   3. upsertProtocolScore creates on first call, increments on second
 *   4. upsertProtocolScore routes 'completion' channel → blink_points
 *   5. upsertUserSeasonScore rollup semantics
 *   6. getProtocolLeaderboard returns entries ordered DESC with rank
 *   7. takeSnapshot idempotency
 *
 * Gated on TEST_DATABASE_URL via describe.skipIf — skips cleanly when
 * unset so `pnpm test` still passes on a dev box without a test DB.
 */

// config.ts validates JWT_SECRET / INTERNAL_API_KEY at import time, so
// we have to inject safe defaults before the first dynamic import. ESM
// hoists static imports, hence the dynamic `await import(...)` inside
// `beforeAll` below.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-leaderboard-service";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-leaderboard-service";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

type LeaderboardServiceModule =
  typeof import("../../src/services/leaderboard-service.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let leaderboardService: LeaderboardServiceModule;
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

const SKIP = !process.env.TEST_DATABASE_URL;

const PROTOCOL_A = "00000000-0000-0000-0000-0000000000a1";
const PROTOCOL_B = "00000000-0000-0000-0000-0000000000a2";
const PROTOCOL_C = "00000000-0000-0000-0000-0000000000a3";
const SEASON_ID = "00000000-0000-0000-0000-0000000000b1";

async function seedProtocols(): Promise<void> {
  const pool = getTestPool();
  for (const [id, name, wallet] of [
    [PROTOCOL_A, "Protocol A", "wallet-protocol-a"],
    [PROTOCOL_B, "Protocol B", "wallet-protocol-b"],
    [PROTOCOL_C, "Protocol C", "wallet-protocol-c"],
  ]) {
    await pool.query(
      `INSERT INTO protocols (id, admin_wallet, name, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [id, wallet, name],
    );
  }
}

async function seedActiveSeason(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO leaderboard_seasons (id, name, start_at, is_active)
     VALUES ($1, $2, NOW(), TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [SEASON_ID, "Unit Test Season"],
  );
}

/**
 * Wrap a callback in a transactional client so the score-upsert
 * contract (client must be inside BEGIN...COMMIT) is honoured. Commits
 * on success, rolls back on throw.
 */
async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getTestPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

describe.skipIf(SKIP)("leaderboard-service", () => {
  beforeAll(async () => {
    const mod = await import("../../src/services/leaderboard-service.js");
    leaderboardService = mod;
    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await seedProtocols();
  });

  /* ------------------------------------------------------------------ */
  /*  getActiveSeason                                                   */
  /* ------------------------------------------------------------------ */

  it("getActiveSeason returns null when no active season exists", async () => {
    const result = await leaderboardService.getActiveSeason();
    expect(result).toBeNull();
  });

  it("getActiveSeason returns the most recently started season when multiple are active", async () => {
    const pool = getTestPool();
    // Older active season
    await pool.query(
      `INSERT INTO leaderboard_seasons (id, name, start_at, is_active)
       VALUES ($1, $2, $3, TRUE)`,
      [
        "00000000-0000-0000-0000-0000000000c1",
        "Older",
        new Date(Date.now() - 86_400_000).toISOString(),
      ],
    );
    // Newer active season
    await pool.query(
      `INSERT INTO leaderboard_seasons (id, name, start_at, is_active)
       VALUES ($1, $2, $3, TRUE)`,
      ["00000000-0000-0000-0000-0000000000c2", "Newer", new Date().toISOString()],
    );

    const result = await leaderboardService.getActiveSeason();
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Newer");
  });

  /* ------------------------------------------------------------------ */
  /*  upsertProtocolScore                                               */
  /* ------------------------------------------------------------------ */

  it("upsertProtocolScore creates a row on first call, increments on second", async () => {
    await seedActiveSeason();

    await withClient(async (client) => {
      await leaderboardService.upsertProtocolScore(
        client,
        SEASON_ID,
        PROTOCOL_A,
        "api",
        100n,
        true,
      );
    });

    const pool = getTestPool();
    const afterFirst = await pool.query<{
      total_points_issued: string;
      api_points: string;
      unique_users_rewarded: number;
    }>(
      `SELECT total_points_issued::text AS total_points_issued,
              api_points::text          AS api_points,
              unique_users_rewarded
         FROM protocol_scores
        WHERE season_id = $1 AND protocol_id = $2`,
      [SEASON_ID, PROTOCOL_A],
    );
    expect(afterFirst.rowCount).toBe(1);
    expect(afterFirst.rows[0].total_points_issued).toBe("100");
    expect(afterFirst.rows[0].api_points).toBe("100");
    expect(afterFirst.rows[0].unique_users_rewarded).toBe(1);

    await withClient(async (client) => {
      await leaderboardService.upsertProtocolScore(
        client,
        SEASON_ID,
        PROTOCOL_A,
        "api",
        250n,
        false,
      );
    });

    const afterSecond = await pool.query<{
      total_points_issued: string;
      api_points: string;
      unique_users_rewarded: number;
    }>(
      `SELECT total_points_issued::text AS total_points_issued,
              api_points::text          AS api_points,
              unique_users_rewarded
         FROM protocol_scores
        WHERE season_id = $1 AND protocol_id = $2`,
      [SEASON_ID, PROTOCOL_A],
    );
    expect(afterSecond.rows[0].total_points_issued).toBe("350");
    expect(afterSecond.rows[0].api_points).toBe("350");
    // isFirstAwardForUser=false on the second call → unique stays at 1
    expect(afterSecond.rows[0].unique_users_rewarded).toBe(1);
  });

  it("upsertProtocolScore routes 'completion' channel into blink_points column", async () => {
    await seedActiveSeason();

    await withClient(async (client) => {
      await leaderboardService.upsertProtocolScore(
        client,
        SEASON_ID,
        PROTOCOL_A,
        "completion",
        500n,
        true,
      );
    });

    const pool = getTestPool();
    const row = await pool.query<{
      total_points_issued: string;
      api_points: string;
      webhook_points: string;
      blink_points: string;
      tweet_points: string;
    }>(
      `SELECT total_points_issued::text AS total_points_issued,
              api_points::text           AS api_points,
              webhook_points::text       AS webhook_points,
              blink_points::text         AS blink_points,
              tweet_points::text         AS tweet_points
         FROM protocol_scores
        WHERE season_id = $1 AND protocol_id = $2`,
      [SEASON_ID, PROTOCOL_A],
    );
    expect(row.rows[0].total_points_issued).toBe("500");
    expect(row.rows[0].blink_points).toBe("500");
    expect(row.rows[0].api_points).toBe("0");
    expect(row.rows[0].webhook_points).toBe("0");
    expect(row.rows[0].tweet_points).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /*  upsertUserSeasonScore                                             */
  /* ------------------------------------------------------------------ */

  it("upsertUserSeasonScore has the same rollup semantics", async () => {
    await seedActiveSeason();
    const wallet = "wallet-user-rollup";

    await withClient(async (client) => {
      await leaderboardService.upsertUserSeasonScore(
        client,
        SEASON_ID,
        wallet,
        "webhook",
        75n,
      );
    });
    await withClient(async (client) => {
      await leaderboardService.upsertUserSeasonScore(
        client,
        SEASON_ID,
        wallet,
        "webhook",
        25n,
      );
    });
    await withClient(async (client) => {
      await leaderboardService.upsertUserSeasonScore(
        client,
        SEASON_ID,
        wallet,
        "completion",
        200n,
      );
    });

    const pool = getTestPool();
    const row = await pool.query<{
      total_points: string;
      webhook_points: string;
      blink_points: string;
      api_points: string;
    }>(
      `SELECT total_points::text    AS total_points,
              webhook_points::text  AS webhook_points,
              blink_points::text    AS blink_points,
              api_points::text      AS api_points
         FROM user_season_scores
        WHERE season_id = $1 AND user_wallet = $2`,
      [SEASON_ID, wallet],
    );
    expect(row.rows[0].total_points).toBe("300");
    expect(row.rows[0].webhook_points).toBe("100");
    // completion rolls into blink_points per the 5→4 contract
    expect(row.rows[0].blink_points).toBe("200");
    expect(row.rows[0].api_points).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /*  getProtocolLeaderboard                                            */
  /* ------------------------------------------------------------------ */

  it("getProtocolLeaderboard returns entries ordered by total_points_issued DESC with correct rank", async () => {
    await seedActiveSeason();

    // Seed three protocols with distinct totals so rank ordering is
    // unambiguous. Use three separate tx's so each upsert commits.
    await withClient((c) =>
      leaderboardService.upsertProtocolScore(
        c,
        SEASON_ID,
        PROTOCOL_A,
        "api",
        100n,
        true,
      ),
    );
    await withClient((c) =>
      leaderboardService.upsertProtocolScore(
        c,
        SEASON_ID,
        PROTOCOL_B,
        "api",
        300n,
        true,
      ),
    );
    await withClient((c) =>
      leaderboardService.upsertProtocolScore(
        c,
        SEASON_ID,
        PROTOCOL_C,
        "api",
        200n,
        true,
      ),
    );

    const result = await leaderboardService.getProtocolLeaderboard(
      SEASON_ID,
      10,
      0,
    );
    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].protocolId).toBe(PROTOCOL_B);
    expect(result.entries[0].rank).toBe(1);
    expect(result.entries[0].totalPointsIssued).toBe("300");
    expect(result.entries[1].protocolId).toBe(PROTOCOL_C);
    expect(result.entries[1].rank).toBe(2);
    expect(result.entries[1].totalPointsIssued).toBe("200");
    expect(result.entries[2].protocolId).toBe(PROTOCOL_A);
    expect(result.entries[2].rank).toBe(3);
    expect(result.entries[2].totalPointsIssued).toBe("100");
  });

  /* ------------------------------------------------------------------ */
  /*  takeSnapshot idempotency                                          */
  /* ------------------------------------------------------------------ */

  it("takeSnapshot is idempotent — a second call returns the same counts without duplicating rows", async () => {
    await seedActiveSeason();

    // Seed two protocols and one user so there is something to snapshot.
    await withClient((c) =>
      leaderboardService.upsertProtocolScore(
        c,
        SEASON_ID,
        PROTOCOL_A,
        "api",
        150n,
        true,
      ),
    );
    await withClient((c) =>
      leaderboardService.upsertProtocolScore(
        c,
        SEASON_ID,
        PROTOCOL_B,
        "api",
        450n,
        true,
      ),
    );
    await withClient((c) =>
      leaderboardService.upsertUserSeasonScore(
        c,
        SEASON_ID,
        "wallet-snap",
        "api",
        100n,
      ),
    );

    const first = await leaderboardService.takeSnapshot(SEASON_ID);
    expect(first.protocolsSnapshotted).toBe(2);
    expect(first.usersSnapshotted).toBe(1);

    const second = await leaderboardService.takeSnapshot(SEASON_ID);
    expect(second.protocolsSnapshotted).toBe(2);
    expect(second.usersSnapshotted).toBe(1);

    // Rows in leaderboard_snapshots must not have doubled.
    const pool = getTestPool();
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM leaderboard_snapshots
        WHERE season_id = $1`,
      [SEASON_ID],
    );
    expect(count.rows[0].count).toBe("3");
  });
});
