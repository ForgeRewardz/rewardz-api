/**
 * Integration test for task 9 (capacity debit) + task 10 (Idempotency-Key
 * middleware) + task 12 (threshold emit).
 *
 * Locks down the invariants laid out in `league-config.md` §Capacity:
 *
 *   1. Award path atomically debits `protocols.remaining_capacity`.
 *   2. Second call with the same idempotency_key does NOT re-debit.
 *   3. Debit failure (remaining < amount) surfaces as CapacityExhaustedError
 *      and leaves NO point_events / NO user_balances mutation.
 *   4. Crossing a league-configured threshold inserts a `protocol_events` row
 *      with kind='capacity_warning'.
 *
 * All four steps happen inside one transaction — a rollback at any point
 * must unwind all of them together.
 *
 * Gated on `TEST_DATABASE_URL` (same pattern as batch-award-rollback.test.ts).
 */

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-capacity";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-capacity";
process.env.SOLANA_NETWORK ??= "devnet";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type PointsServiceModule = typeof import("../src/services/points-service.js");
type CapacityModule = typeof import("../src/services/capacity.js");
type TestDbModule = typeof import("./helpers/test-db.js");

let awardPoints: PointsServiceModule["awardPoints"];
let CapacityExhaustedError: CapacityModule["CapacityExhaustedError"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

const SKIP = !process.env.TEST_DATABASE_URL;

const PROTOCOL_ID = "00000000-0000-0000-0000-000000000cap";
const WALLET = "CAPtestwallet1111111111111111111111111111111";

async function seedProtocol(remaining: number | null): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status, remaining_capacity)
     VALUES ($1, $2, 'Capacity Test', 'active', $3)
     ON CONFLICT (id) DO UPDATE SET remaining_capacity = EXCLUDED.remaining_capacity`,
    [PROTOCOL_ID, "CAPadmin11111111111111111111111111111111111", remaining],
  );
}

async function readCapacity(): Promise<bigint | null> {
  const pool = getTestPool();
  const res = await pool.query<{ remaining_capacity: string | null }>(
    "SELECT remaining_capacity FROM protocols WHERE id = $1",
    [PROTOCOL_ID],
  );
  const v = res.rows[0]?.remaining_capacity;
  return v === null || v === undefined ? null : BigInt(v);
}

async function countPointEvents(): Promise<number> {
  const pool = getTestPool();
  const res = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM point_events WHERE protocol_id = $1",
    [PROTOCOL_ID],
  );
  return Number(res.rows[0].count);
}

async function listCapacityEvents(): Promise<
  Array<{ kind: string; level: string; payload: Record<string, unknown> }>
> {
  const pool = getTestPool();
  const res = await pool.query<{
    kind: string;
    level: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT kind, level, payload FROM protocol_events
      WHERE protocol_id = $1 AND kind = 'capacity_warning'
      ORDER BY created_at ASC`,
    [PROTOCOL_ID],
  );
  return res.rows;
}

beforeAll(async () => {
  if (SKIP) return;
  const pointsMod = await import("../src/services/points-service.js");
  const capacityMod = await import("../src/services/capacity.js");
  const dbMod = await import("./helpers/test-db.js");
  awardPoints = pointsMod.awardPoints;
  CapacityExhaustedError = capacityMod.CapacityExhaustedError;
  setupTestDb = dbMod.setupTestDb;
  teardownTestDb = dbMod.teardownTestDb;
  truncateAllTables = dbMod.truncateAllTables;
  getTestPool = dbMod.getTestPool;
  await setupTestDb();
});

afterAll(async () => {
  if (SKIP) return;
  await teardownTestDb();
});

beforeEach(async () => {
  if (SKIP) return;
  await truncateAllTables();
});

describe.skipIf(SKIP)("capacity debit on /points/award", () => {
  it("debits remaining_capacity on successful award", async () => {
    await seedProtocol(500);

    const result = await awardPoints(
      WALLET,
      50n,
      PROTOCOL_ID,
      { type: "reference", key: "idem-cap-1" },
      "test award",
      "api",
      { enforceCapacity: true },
    );

    expect(result.success).toBe(true);
    expect(result.duplicate).toBeFalsy();
    expect(await readCapacity()).toBe(450n);
    expect(await countPointEvents()).toBe(1);
  });

  it("throws CapacityExhaustedError when debit exceeds remaining", async () => {
    await seedProtocol(20);

    await expect(
      awardPoints(
        WALLET,
        50n,
        PROTOCOL_ID,
        { type: "reference", key: "idem-cap-2" },
        "test award",
        "api",
        { enforceCapacity: true },
      ),
    ).rejects.toBeInstanceOf(CapacityExhaustedError);

    // Rollback invariant: nothing debited, nothing inserted.
    expect(await readCapacity()).toBe(20n);
    expect(await countPointEvents()).toBe(0);
  });

  it("throws when remaining_capacity IS NULL (not bootstrapped)", async () => {
    await seedProtocol(null);

    await expect(
      awardPoints(
        WALLET,
        10n,
        PROTOCOL_ID,
        { type: "reference", key: "idem-cap-null" },
        "test award",
        "api",
        { enforceCapacity: true },
      ),
    ).rejects.toBeInstanceOf(CapacityExhaustedError);

    expect(await readCapacity()).toBeNull();
    expect(await countPointEvents()).toBe(0);
  });

  it("does not double-debit on idempotent retry", async () => {
    await seedProtocol(500);

    const first = await awardPoints(
      WALLET,
      30n,
      PROTOCOL_ID,
      { type: "reference", key: "idem-cap-retry" },
      "test award",
      "api",
      { enforceCapacity: true },
    );
    expect(first.duplicate).toBeFalsy();
    expect(await readCapacity()).toBe(470n);

    // Same idempotency key → dup-check fires before capacity UPDATE.
    const second = await awardPoints(
      WALLET,
      30n,
      PROTOCOL_ID,
      { type: "reference", key: "idem-cap-retry" },
      "test award",
      "api",
      { enforceCapacity: true },
    );
    expect(second.duplicate).toBe(true);
    expect(await readCapacity()).toBe(470n); // unchanged
    expect(await countPointEvents()).toBe(1);
  });

  it("emits protocol_events row when crossing 25% threshold", async () => {
    // starter_grant_rewardz is 100 on devnet. 25% → 25. 10% → 10.
    // Start at 40 (above 25% of 100), debit 20 → land at 20 (below 25%).
    await seedProtocol(40);

    await awardPoints(
      WALLET,
      20n,
      PROTOCOL_ID,
      { type: "reference", key: "idem-cap-threshold" },
      "test award",
      "api",
      { enforceCapacity: true },
    );

    const events = await listCapacityEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].kind).toBe("capacity_warning");
    expect(events[0].level).toBe("warning");
    expect(events[0].payload.threshold_pct).toBe(0.25);
  });

  it("emits critical event when hitting 0 capacity", async () => {
    await seedProtocol(10);

    await awardPoints(
      WALLET,
      10n,
      PROTOCOL_ID,
      { type: "reference", key: "idem-cap-zero" },
      "test award",
      "api",
      { enforceCapacity: true },
    );

    expect(await readCapacity()).toBe(0n);
    const events = await listCapacityEvents();
    const critical = events.find((e) => e.level === "critical");
    expect(critical).toBeDefined();
    expect(critical?.payload.threshold_pct).toBe(0);
  });

  it("emits critical (not warning) when a single debit spans multiple thresholds", async () => {
    // baseline 100, thresholds [0.25, 0.10, 0.0] → bounds 25, 10, 0.
    // Debit from 40 → 0 crosses ALL three. Must surface critical (lowest pct).
    await seedProtocol(40);

    await awardPoints(
      WALLET,
      40n,
      PROTOCOL_ID,
      { type: "reference", key: "idem-cap-multi" },
      "test award",
      "api",
      { enforceCapacity: true },
    );

    expect(await readCapacity()).toBe(0n);
    const events = await listCapacityEvents();
    expect(events.length).toBe(1);
    expect(events[0].level).toBe("critical");
    expect(events[0].payload.threshold_pct).toBe(0);
  });

  it("skips capacity debit when enforceCapacity=false (legacy callers)", async () => {
    await seedProtocol(50);

    const result = await awardPoints(
      WALLET,
      100n, // exceeds capacity
      PROTOCOL_ID,
      { type: "reference", key: "idem-cap-legacy" },
      "test award",
      "api",
      { enforceCapacity: false },
    );

    expect(result.success).toBe(true);
    expect(await readCapacity()).toBe(50n); // untouched
    expect(await countPointEvents()).toBe(1);
  });
});
