process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-game-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-game-e2e";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

type TestAppModule = typeof import("../helpers/test-app.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let createTestApp: TestAppModule["createTestApp"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];
let app: Awaited<ReturnType<TestAppModule["createTestApp"]>>;

const SKIP = !process.env.TEST_DATABASE_URL;
const WALLET_A = "So11111111111111111111111111111111111111112";
const WALLET_B = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

async function seedRound(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO game_rounds (
       round_id, start_slot, end_slot, status, player_count,
       game_fee_lamports, hit_rate_bps, tokens_per_round,
       motherlode_pool, motherlode_min_threshold, motherlode_probability_bps,
       hit_count, total_hit_points, tokens_minted, motherlode_triggered,
       motherlode_amount
     )
     VALUES (1, 100, 250, 'settled', 2, 6000000, 5000, 1000,
             200, 1000, 100, 1, 500, 1000, false, 0)`,
  );
  await pool.query(
    `INSERT INTO player_deployments (
       round_id, wallet_address, points_deployed, fee_paid, deployed_at,
       is_hit, reward_amount, motherlode_share, claimed, settled
     )
     VALUES
       (1, $1, 500, 6000000, NOW(), true, 800, 0, false, true),
       (1, $2, 300, 6000000, NOW(), false, 0, 0, false, true)`,
    [WALLET_A, WALLET_B],
  );
}

describe.skipIf(SKIP)("game routes", () => {
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

  it("GET /v1/game/round/current returns null when no active round exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/game/round/current",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ round: null, player: null });
  });

  it("GET /v1/game/round/:id/status returns round and caller deployment", async () => {
    await seedRound();
    const res = await app.inject({
      method: "GET",
      url: `/v1/game/round/1/status?wallet=${WALLET_A}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      round: { roundId: string; status: string; playerCount: number };
      player: { walletAddress: string; result: string; rewardAmount: string };
    };
    expect(body.round).toMatchObject({
      roundId: "1",
      status: "settled",
      playerCount: 2,
    });
    expect(body.player).toMatchObject({
      walletAddress: WALLET_A,
      result: "hit",
      rewardAmount: "800",
    });
  });

  it("GET /v1/game/round/:id/players only exposes total count and caller deployment", async () => {
    await seedRound();
    const res = await app.inject({
      method: "GET",
      url: `/v1/game/round/1/players?wallet=${WALLET_A}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      playerCount: number;
      player: { walletAddress: string; pointsDeployed: string };
    };
    expect(body.playerCount).toBe(2);
    expect(body.player.walletAddress).toBe(WALLET_A);
    expect(body.player.pointsDeployed).toBe("500");
    expect(JSON.stringify(body)).not.toContain(WALLET_B);
    expect(JSON.stringify(body)).not.toContain("300");
  });

  it("GET /v1/game/round/:id/results returns settled aggregate stats", async () => {
    await seedRound();
    const res = await app.inject({
      method: "GET",
      url: `/v1/game/round/1/results?wallet=${WALLET_B}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      hitCount: number;
      totalHitPoints: string;
      tokensMinted: string;
      player: { walletAddress: string; result: string; rewardAmount: string };
    };
    expect(body.hitCount).toBe(1);
    expect(body.totalHitPoints).toBe("500");
    expect(body.tokensMinted).toBe("1000");
    expect(body.player).toMatchObject({
      walletAddress: WALLET_B,
      result: "miss",
      rewardAmount: "0",
    });
  });

  it("GET /v1/game/round/history returns recent rounds", async () => {
    await seedRound();
    const res = await app.inject({
      method: "GET",
      url: "/v1/game/round/history?limit=5",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ roundId: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries[0]?.roundId).toBe("1");
  });
});
