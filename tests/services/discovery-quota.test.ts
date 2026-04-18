/**
 * Unit tests for src/services/discovery-quota.ts.
 *
 * Gated on TEST_DATABASE_URL via describe.skipIf — skips cleanly when
 * unset so `pnpm test` still passes on a dev box without a test DB.
 */

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-discovery-quota";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-discovery-quota";
process.env.DISCOVERY_FREE_QUOTA_PER_DAY ??= "3";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type DiscoveryQuotaModule =
  typeof import("../../src/services/discovery-quota.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let discoveryQuota: DiscoveryQuotaModule;
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let getTestPool: TestDbModule["getTestPool"];

const SKIP = !process.env.TEST_DATABASE_URL;

const WALLET_A = "wallet-discovery-a";
const WALLET_B = "wallet-discovery-b";

describe.skipIf(SKIP)("discovery-quota", () => {
  beforeAll(async () => {
    const mod = await import("../../src/services/discovery-quota.js");
    discoveryQuota = mod;
    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    getTestPool = testDb.getTestPool;

    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    const pool = getTestPool();
    await pool.query("TRUNCATE TABLE discovery_usage");
  });

  it("readQuota on a fresh wallet returns used=0 and full remaining", async () => {
    const state = await discoveryQuota.readQuota(WALLET_A);
    expect(state.wallet).toBe(WALLET_A);
    expect(state.used).toBe(0);
    expect(state.remaining).toBe(3);
  });

  it("consumeQuota first call returns consumed=true with used=1, remaining=2", async () => {
    const state = await discoveryQuota.consumeQuota(WALLET_A);
    expect(state.consumed).toBe(true);
    expect(state.used).toBe(1);
    expect(state.remaining).toBe(2);

    const readBack = await discoveryQuota.readQuota(WALLET_A);
    expect(readBack.used).toBe(1);
    expect(readBack.remaining).toBe(2);
  });

  it("after 3 consumes the 4th is blocked with consumed=false and remaining=0", async () => {
    const first = await discoveryQuota.consumeQuota(WALLET_A);
    expect(first.consumed).toBe(true);
    const second = await discoveryQuota.consumeQuota(WALLET_A);
    expect(second.consumed).toBe(true);
    const third = await discoveryQuota.consumeQuota(WALLET_A);
    expect(third.consumed).toBe(true);
    expect(third.used).toBe(3);
    expect(third.remaining).toBe(0);

    const fourth = await discoveryQuota.consumeQuota(WALLET_A);
    expect(fourth.consumed).toBe(false);
    expect(fourth.used).toBe(3);
    expect(fourth.remaining).toBe(0);
  });

  it("two concurrent consumeQuota calls for the same wallet cannot both succeed when only one slot remains", async () => {
    // Burn the first 2 slots sequentially so the wallet has exactly 1 left.
    await discoveryQuota.consumeQuota(WALLET_B);
    await discoveryQuota.consumeQuota(WALLET_B);

    const settled = await Promise.allSettled([
      discoveryQuota.consumeQuota(WALLET_B),
      discoveryQuota.consumeQuota(WALLET_B),
    ]);

    // Neither call should reject — both resolve cleanly; only one consumes.
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);

    const results = settled.map((r) =>
      r.status === "fulfilled" ? r.value : null,
    );
    const successes = results.filter((r) => r?.consumed === true).length;
    const failures = results.filter((r) => r?.consumed === false).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    const final = await discoveryQuota.readQuota(WALLET_B);
    expect(final.used).toBe(3);
    expect(final.remaining).toBe(0);
  });

  it("two concurrent consumeQuota calls for a fresh wallet (no pre-seeded row) both complete without error", async () => {
    const FRESH_WALLET = "wallet-discovery-fresh-race";

    // Do NOT pre-seed the row. Fire both calls immediately so they race on
    // the INSERT path — the previous SELECT FOR UPDATE implementation would
    // let both reach the plain INSERT and one would throw a unique-violation.
    const settled = await Promise.allSettled([
      discoveryQuota.consumeQuota(FRESH_WALLET),
      discoveryQuota.consumeQuota(FRESH_WALLET),
    ]);

    // Both must resolve — this is the exact bug the fix eliminates.
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);

    const results = settled
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    expect(results.every((r) => r.consumed === true)).toBe(true);

    const usedValues = results.map((r) => r.used).sort();
    expect(usedValues).toEqual([1, 2]);

    const final = await discoveryQuota.readQuota(FRESH_WALLET);
    expect(final.used).toBe(2);
    expect(final.remaining).toBe(1);
  });

  it("resetAtUtc is a valid ISO timestamp at 00:00:00.000Z of the next UTC day", async () => {
    const state = await discoveryQuota.readQuota(WALLET_A);
    const reset = new Date(state.resetAtUtc);
    expect(Number.isNaN(reset.getTime())).toBe(false);
    expect(reset.getUTCHours()).toBe(0);
    expect(reset.getUTCMinutes()).toBe(0);
    expect(reset.getUTCSeconds()).toBe(0);
    expect(reset.getUTCMilliseconds()).toBe(0);

    const today = new Date();
    const expectedDay = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    );
    expect(reset.getUTCFullYear()).toBe(expectedDay.getUTCFullYear());
    expect(reset.getUTCMonth()).toBe(expectedDay.getUTCMonth());
    expect(reset.getUTCDate()).toBe(expectedDay.getUTCDate());
  });

  it("quota is isolated per wallet — consuming for WALLET_A does not affect WALLET_B", async () => {
    await discoveryQuota.consumeQuota(WALLET_A);
    await discoveryQuota.consumeQuota(WALLET_A);

    const b = await discoveryQuota.readQuota(WALLET_B);
    expect(b.used).toBe(0);
    expect(b.remaining).toBe(3);
  });
});
