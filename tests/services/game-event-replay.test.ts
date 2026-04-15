/**
 * DB-backed regression tests for the F8-retry follow-up:
 *
 *   • Fix A — RoundSettled wires synthesizePlayerOutcome so
 *     player_deployments rows are populated with (is_hit, reward_amount,
 *     motherlode_share) ahead of CheckpointRecorded arriving.
 *   • Fix C — CheckpointRecorded is idempotent under replay: the
 *     sibling `game_rounds.hit_count` / `tokens_minted` counters MUST
 *     NOT drift when the RPC logsSubscribe stream re-delivers a
 *     previously-applied event.
 *
 * Gated on `TEST_DATABASE_URL` — skips cleanly when unset so `pnpm test`
 * still passes on a developer box without a dedicated test Postgres.
 */

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-game-event-replay";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-game-event-replay";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type GameServiceModule = typeof import("../../src/services/game-service.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let applyGameEvent: GameServiceModule["applyGameEvent"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

const SKIP = !process.env.TEST_DATABASE_URL;

const ROUND_ID = "9999";
const WALLET_A = "So11111111111111111111111111111111111111112";
const WALLET_B = "BPFLoaderUpgradeab1e11111111111111111111111";

describe.skipIf(SKIP)("F8-retry: game event replay + synthesis", () => {
  beforeAll(async () => {
    const gameService = await import("../../src/services/game-service.js");
    applyGameEvent = gameService.applyGameEvent;
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
  });

  it("Fix C: CheckpointRecorded replay does not double-count counters", async () => {
    // Seed a round + one deployment in the pre-checkpoint state.
    await applyGameEvent({
      eventName: "RoundStarted",
      roundId: ROUND_ID,
      startSlot: "1000",
      endSlot: "1150",
    });
    await applyGameEvent({
      eventName: "PlayerDeployed",
      roundId: ROUND_ID,
      walletAddress: WALLET_A,
      pointsDeployed: "100",
    });

    // First CheckpointRecorded — bumps counters.
    await applyGameEvent(
      {
        eventName: "CheckpointRecorded",
        roundId: ROUND_ID,
        walletAddress: WALLET_A,
        rewardAmount: "500",
        isHit: true,
      },
      "sig-checkpoint-original",
    );

    let round = await getTestPool().query(
      "SELECT hit_count, tokens_minted::text FROM game_rounds WHERE round_id = $1",
      [ROUND_ID],
    );
    expect(round.rows[0].hit_count).toBe(1);
    expect(round.rows[0].tokens_minted).toBe("500");

    // Replay the SAME event (RPC reconnect path). Counters MUST stay put.
    await applyGameEvent(
      {
        eventName: "CheckpointRecorded",
        roundId: ROUND_ID,
        walletAddress: WALLET_A,
        rewardAmount: "500",
        isHit: true,
      },
      "sig-checkpoint-original",
    );
    await applyGameEvent(
      {
        eventName: "CheckpointRecorded",
        roundId: ROUND_ID,
        walletAddress: WALLET_A,
        rewardAmount: "500",
        isHit: true,
      },
      "sig-checkpoint-replay-alt-sig",
    );

    round = await getTestPool().query(
      "SELECT hit_count, tokens_minted::text FROM game_rounds WHERE round_id = $1",
      [ROUND_ID],
    );
    expect(round.rows[0].hit_count).toBe(1);
    expect(round.rows[0].tokens_minted).toBe("500");
  });

  it("Fix C: miss events never bump counters, even on first delivery", async () => {
    await applyGameEvent({
      eventName: "RoundStarted",
      roundId: ROUND_ID,
      startSlot: "1000",
      endSlot: "1150",
    });
    await applyGameEvent({
      eventName: "PlayerDeployed",
      roundId: ROUND_ID,
      walletAddress: WALLET_A,
      pointsDeployed: "100",
    });
    await applyGameEvent({
      eventName: "CheckpointRecorded",
      roundId: ROUND_ID,
      walletAddress: WALLET_A,
      rewardAmount: "0",
      isHit: false,
    });
    const round = await getTestPool().query(
      "SELECT hit_count, tokens_minted::text FROM game_rounds WHERE round_id = $1",
      [ROUND_ID],
    );
    expect(round.rows[0].hit_count).toBe(0);
    expect(round.rows[0].tokens_minted).toBe("0");
  });

  it("Fix A: RoundSettled fills is_hit/reward_amount/motherlode_share when slot_hash is known", async () => {
    // Seed round + two deployments; synthesize expects a slot_hash row
    // on game_rounds (migration 038 column). In production the keeper
    // backfills this; here we write it directly.
    await applyGameEvent({
      eventName: "RoundStarted",
      roundId: ROUND_ID,
      startSlot: "1000",
      endSlot: "1150",
    });
    await applyGameEvent({
      eventName: "PlayerDeployed",
      roundId: ROUND_ID,
      walletAddress: WALLET_A,
      pointsDeployed: "100",
    });
    await applyGameEvent({
      eventName: "PlayerDeployed",
      roundId: ROUND_ID,
      walletAddress: WALLET_B,
      pointsDeployed: "100",
    });

    // Backfill a deterministic slot_hash so synthesis runs.
    const slotHashBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    await getTestPool().query(
      "UPDATE game_rounds SET slot_hash = $2, tokens_minted = 1000 WHERE round_id = $1",
      [ROUND_ID, slotHashBytes],
    );

    await applyGameEvent({
      eventName: "RoundSettled",
      roundId: ROUND_ID,
      settleTimestamp: "0",
      expiresAt: "99999",
      refundMode: false,
      totalPointsDeployed: "200",
    });

    const players = await getTestPool().query<{
      wallet_address: string;
      is_hit: boolean | null;
      reward_amount: string;
      motherlode_share: string;
      settled: boolean;
    }>(
      `SELECT wallet_address, is_hit, reward_amount::text,
              motherlode_share::text, settled
         FROM player_deployments
        WHERE round_id = $1
        ORDER BY wallet_address`,
      [ROUND_ID],
    );
    // Synthesis wrote is_hit/reward_amount for both rows but did NOT
    // set settled=true — that flag is reserved for authoritative
    // CheckpointRecorded writes.
    expect(players.rows.length).toBe(2);
    for (const p of players.rows) {
      expect(p.is_hit).not.toBeNull();
      expect(p.settled).toBe(false);
      // motherlode_share defaults to 0 because motherlode_triggered=false
      // on this fresh round.
      expect(p.motherlode_share).toBe("0");
    }
  });

  it("Fix A: RoundSettled is a no-op for synthesis when slot_hash is null", async () => {
    await applyGameEvent({
      eventName: "RoundStarted",
      roundId: ROUND_ID,
      startSlot: "1000",
      endSlot: "1150",
    });
    await applyGameEvent({
      eventName: "PlayerDeployed",
      roundId: ROUND_ID,
      walletAddress: WALLET_A,
      pointsDeployed: "100",
    });
    await applyGameEvent({
      eventName: "RoundSettled",
      roundId: ROUND_ID,
      settleTimestamp: "0",
      expiresAt: "99999",
      refundMode: false,
      totalPointsDeployed: "100",
    });
    const players = await getTestPool().query<{
      is_hit: boolean | null;
    }>("SELECT is_hit FROM player_deployments WHERE round_id = $1", [ROUND_ID]);
    // With no slot_hash, synthesis skips silently — is_hit stays NULL.
    expect(players.rows[0].is_hit).toBeNull();
  });

  it("Fix A: RoundSettled in refund mode does not run synthesis", async () => {
    await applyGameEvent({
      eventName: "RoundStarted",
      roundId: ROUND_ID,
      startSlot: "1000",
      endSlot: "1150",
    });
    await applyGameEvent({
      eventName: "PlayerDeployed",
      roundId: ROUND_ID,
      walletAddress: WALLET_A,
      pointsDeployed: "100",
    });
    // Even with slot_hash populated, refund_mode short-circuits synthesis.
    const slotHashBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    await getTestPool().query(
      "UPDATE game_rounds SET slot_hash = $2 WHERE round_id = $1",
      [ROUND_ID, slotHashBytes],
    );
    await applyGameEvent({
      eventName: "RoundSettled",
      roundId: ROUND_ID,
      settleTimestamp: "0",
      expiresAt: "99999",
      refundMode: true,
      totalPointsDeployed: "100",
    });
    const players = await getTestPool().query<{
      is_hit: boolean | null;
      reward_amount: string;
    }>(
      "SELECT is_hit, reward_amount::text FROM player_deployments WHERE round_id = $1",
      [ROUND_ID],
    );
    expect(players.rows[0].is_hit).toBeNull();
    expect(players.rows[0].reward_amount).toBe("0");
  });
});
