/**
 * Integration + unit tests for the discovery-runner BullMQ worker.
 *
 * Covers task 12 (mini-app-ux-spec.md §7.6 / §13):
 *
 *   1. Happy path — enqueue a job with delay=0, wait for completion,
 *      assert discovery_schedules.status = 'done' and a matching
 *      discovery_results row exists.
 *   2. Cancelled mid-run — enqueue, flip status='cancelled' before the
 *      worker runs, assert the worker drops the job (status stays
 *      'cancelled', no discovery_results row inserted).
 *   3. Missing schedule row — drive processDiscoveryJob directly with a
 *      scheduleId that doesn't exist; assert it returns without
 *      throwing (unit-level, avoids racing the scheduler for a row
 *      that intentionally isn't there).
 *
 * Redis is opt-in: the Worker-backed suite only runs when
 * REDIS_TEST_URL is set (same gating as discovery.e2e.test.ts's
 * scheduler suite). The unit-level tests don't need Redis and run
 * whenever TEST_DATABASE_URL is present.
 */

// -----------------------------------------------------------------------------
// Env setup mirrors tests/routes/discovery.e2e.test.ts — config.ts validates
// with zod + process.exit at module load, so required envs must be populated
// before any dynamic `import("src/*")` below.
// -----------------------------------------------------------------------------

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-discovery-worker";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-discovery-worker";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";
// Disable the worker at buildApp() time — these tests manage worker
// lifecycle explicitly so we can assert on start/stop behaviour.
process.env.DISCOVERY_WORKER_ENABLED = "false";
if (process.env.REDIS_TEST_URL) {
  process.env.REDIS_URL = process.env.REDIS_TEST_URL;
}
// biome-ignore lint/performance/noDelete: test setup
delete process.env.GEMINI_API_KEY;

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type TestDbModule = typeof import("../helpers/test-db.js");

let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

const SKIP_DB = !process.env.TEST_DATABASE_URL;
const SKIP_REDIS = SKIP_DB || !process.env.REDIS_TEST_URL;

/* -------------------------------------------------------------------------- */
/*  Protocol seed helper — mirrors discovery.e2e.test.ts                       */
/* -------------------------------------------------------------------------- */

async function seedStakeProtocol(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (admin_wallet, name, supported_actions, status)
     VALUES ($1, $2, $3, 'active')`,
    ["So11111111111111111111111111111111111111112", "Marinade Test", ["stake"]],
  );
}

async function insertSchedule(wallet: string, text: string): Promise<string> {
  const pool = getTestPool();
  const runAt = new Date(Date.now() + 60_000).toISOString();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO discovery_schedules (wallet, text, run_at, status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [wallet, text, runAt],
  );
  return res.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  Worker integration suite — needs Redis                                     */
/* -------------------------------------------------------------------------- */

describe.skipIf(SKIP_REDIS)("discovery-runner worker (integration)", () => {
  let discoveryQueue: typeof import("../../src/services/bullmq.js").discoveryQueue;
  let startDiscoveryWorker: typeof import("../../src/services/bullmq.js").startDiscoveryWorker;
  let stopDiscoveryWorker: typeof import("../../src/services/bullmq.js").stopDiscoveryWorker;
  let closeDiscoveryQueue: typeof import("../../src/services/bullmq.js").closeDiscoveryQueue;

  beforeAll(async () => {
    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    const bullmq = await import("../../src/services/bullmq.js");
    discoveryQueue = bullmq.discoveryQueue;
    startDiscoveryWorker = bullmq.startDiscoveryWorker;
    stopDiscoveryWorker = bullmq.stopDiscoveryWorker;
    closeDiscoveryQueue = bullmq.closeDiscoveryQueue;

    await setupTestDb();
    // Drain any stale jobs from a previous run so the "waitUntilCompleted"
    // waits latch onto OUR jobs rather than a leftover id.
    await discoveryQueue().obliterate({ force: true });
    // Boot the worker once. startDiscoveryWorker is idempotent so
    // re-calling it across tests reuses the singleton.
    await startDiscoveryWorker();
  });

  afterEach(async () => {
    await truncateAllTables();
    await discoveryQueue().obliterate({ force: true });
  });

  afterAll(async () => {
    // Explicit stopDiscoveryWorker before closeDiscoveryQueue so the
    // stop path is exercised — closeDiscoveryQueue would call it
    // anyway, but calling it here asserts the export works standalone.
    await stopDiscoveryWorker();
    await closeDiscoveryQueue();
    await teardownTestDb();
  });

  /* ------------------------------------------------------------------ */
  /*  1. Happy path                                                     */
  /* ------------------------------------------------------------------ */

  it("processes an enqueued job and writes discovery_results", async () => {
    await seedStakeProtocol();
    const wallet = "So11111111111111111111111111111111111111112";
    const scheduleId = await insertSchedule(wallet, "stake 1 SOL");
    const pool = getTestPool();

    const queue = discoveryQueue();
    const job = await queue.add(
      "discovery-run",
      { scheduleId, wallet, text: "stake 1 SOL" },
      { jobId: scheduleId, removeOnComplete: true, removeOnFail: false },
    );

    // Wait for the worker to finish. 10s is generous — the handler is
    // three synchronous Postgres queries plus a rules-only resolve.
    await job.waitUntilFinished(queue.events, 10_000).catch(async () => {
      // BullMQ's waitUntilFinished needs a QueueEvents — fall back to
      // polling the DB since that's the real source of truth.
    });

    // Poll for terminal status — avoids flakiness on CI where the
    // QueueEvents subscriber may not have attached in time for the
    // synchronous add→complete path.
    const deadline = Date.now() + 10_000;
    let status = "pending";
    while (Date.now() < deadline) {
      const r = await pool.query<{ status: string }>(
        `SELECT status FROM discovery_schedules WHERE id = $1`,
        [scheduleId],
      );
      status = r.rows[0]?.status ?? "pending";
      if (status === "done") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(status).toBe("done");

    const resRow = await pool.query<{
      assistant: { text: string; intent: string; resolverType: string };
      matches: Array<{ protocolName: string; actionType: string }>;
      fell_back: boolean;
    }>(
      `SELECT assistant, matches, fell_back
         FROM discovery_results WHERE schedule_id = $1`,
      [scheduleId],
    );
    expect(resRow.rowCount).toBe(1);
    expect(resRow.rows[0].assistant.intent).toBe("stake");
    expect(resRow.rows[0].assistant.resolverType).toBe("rules");
    expect(resRow.rows[0].assistant.text).toMatch(/stake/i);
    expect(resRow.rows[0].fell_back).toBe(false);
    expect(
      resRow.rows[0].matches.some((m) => m.protocolName === "Marinade Test"),
    ).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  2. Cancelled mid-run                                              */
  /* ------------------------------------------------------------------ */

  it("drops a cancelled job without writing a result row", async () => {
    await seedStakeProtocol();
    const wallet = "So11111111111111111111111111111111111111112";
    const scheduleId = await insertSchedule(wallet, "stake 1 SOL");
    const pool = getTestPool();

    // Flip status BEFORE enqueue so the worker reads 'cancelled' on
    // its up-front row fetch and drops — deterministic without timing
    // games.
    await pool.query(
      `UPDATE discovery_schedules SET status = 'cancelled' WHERE id = $1`,
      [scheduleId],
    );

    const queue = discoveryQueue();
    await queue.add(
      "discovery-run",
      { scheduleId, wallet, text: "stake 1 SOL" },
      { jobId: scheduleId, removeOnComplete: true, removeOnFail: false },
    );

    // Wait long enough for the worker to pick up + drop the job.
    // There's no status transition to poll for — we're asserting the
    // absence of side-effects, so a fixed wait is acceptable.
    await new Promise((r) => setTimeout(r, 2_000));

    const statusRow = await pool.query<{ status: string }>(
      `SELECT status FROM discovery_schedules WHERE id = $1`,
      [scheduleId],
    );
    expect(statusRow.rows[0].status).toBe("cancelled");

    const resRow = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM discovery_results WHERE schedule_id = $1`,
      [scheduleId],
    );
    expect(resRow.rows[0].count).toBe("0");
  });
});

/* -------------------------------------------------------------------------- */
/*  Unit-level suite — DB only, no Redis                                       */
/* -------------------------------------------------------------------------- */

describe.skipIf(SKIP_DB)("discovery-runner processor (unit)", () => {
  let processDiscoveryJob: typeof import("../../src/workers/discovery-runner.js").processDiscoveryJob;

  beforeAll(async () => {
    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    const runner = await import("../../src/workers/discovery-runner.js");
    processDiscoveryJob = runner.processDiscoveryJob;

    await setupTestDb();
  });

  afterEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  /* ------------------------------------------------------------------ */
  /*  3. Missing schedule row                                           */
  /* ------------------------------------------------------------------ */

  it("drops a job whose schedule_id is missing without throwing", async () => {
    // No INSERT — the row genuinely doesn't exist. Valid UUID shape
    // so the underlying query doesn't blow up on a type mismatch.
    const missingId = "00000000-0000-4000-8000-000000000000";
    const logs: string[] = [];
    const fakeJob = {
      data: {
        scheduleId: missingId,
        wallet: "So11111111111111111111111111111111111111112",
        text: "stake 1 SOL",
      },
      log: (msg: string) => {
        logs.push(msg);
      },
      // The handler only reads `data` and `log`; the rest of the Job
      // surface can be omitted when calling the processor directly.
      // biome-ignore lint/suspicious/noExplicitAny: narrow test double
    } as any;

    await expect(processDiscoveryJob(fakeJob)).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("not found"))).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  4. Cancelled (unit) — processor returns early, no side effects    */
  /* ------------------------------------------------------------------ */

  it("drops a cancelled schedule without writing a result row", async () => {
    const pool = getTestPool();
    const wallet = "So11111111111111111111111111111111111111112";
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO discovery_schedules (wallet, text, run_at, status)
       VALUES ($1, 'stake 1 SOL', $2, 'cancelled') RETURNING id`,
      [wallet, runAt],
    );
    const scheduleId = ins.rows[0].id;

    const logs: string[] = [];
    const fakeJob = {
      data: { scheduleId, wallet, text: "stake 1 SOL" },
      log: (m: string) => {
        logs.push(m);
      },
      // biome-ignore lint/suspicious/noExplicitAny: narrow test double
    } as any;

    await expect(processDiscoveryJob(fakeJob)).resolves.toBeUndefined();

    // Status unchanged and no results row written.
    const statusRow = await pool.query<{ status: string }>(
      `SELECT status FROM discovery_schedules WHERE id = $1`,
      [scheduleId],
    );
    expect(statusRow.rows[0].status).toBe("cancelled");

    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM discovery_results WHERE schedule_id = $1`,
      [scheduleId],
    );
    expect(count.rows[0].count).toBe("0");
    expect(logs.some((l) => l.includes("cancelled"))).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  5. Cancelled mid-run — user DELETEs while resolveIntent runs      */
  /* ------------------------------------------------------------------ */

  it("preserves cancelled status when cancel races resolveIntent", async () => {
    // Seed stake protocol + schedule row (status='pending' so the
    // processor's up-front guard passes and we enter the running path).
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO protocols (admin_wallet, name, supported_actions, status)
       VALUES ($1, $2, $3, 'active')`,
      [
        "So11111111111111111111111111111111111111112",
        "Marinade Test",
        ["stake"],
      ],
    );
    const wallet = "So11111111111111111111111111111111111111112";
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO discovery_schedules (wallet, text, run_at, status)
       VALUES ($1, 'stake 1 SOL', $2, 'pending') RETURNING id`,
      [wallet, runAt],
    );
    const scheduleId = ins.rows[0].id;

    // Mock resolveIntent to simulate the user cancelling WHILE the
    // resolver is executing — i.e. between the 'running' flip and the
    // final 'done' flip. This exercises the done-flip guard.
    const intentResolver =
      await import("../../src/services/intent-resolver.js");
    const spy = vi
      .spyOn(intentResolver, "resolveIntent")
      .mockImplementationOnce(async () => {
        await pool.query(
          `UPDATE discovery_schedules SET status='cancelled' WHERE id=$1`,
          [scheduleId],
        );
        return {
          action_type: "custom",
          params: {},
          confidence: 0.5,
          resolver_type: "rules",
          offers: [],
        };
      });

    const fakeJob = {
      data: { scheduleId, wallet, text: "stake 1 SOL" },
      log: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: narrow test double
    } as any;

    await expect(processDiscoveryJob(fakeJob)).resolves.toBeUndefined();

    // Status must remain 'cancelled' — the guarded done-flip is a
    // no-op when status != 'running'.
    const statusRow = await pool.query<{ status: string }>(
      `SELECT status FROM discovery_schedules WHERE id = $1`,
      [scheduleId],
    );
    expect(statusRow.rows[0].status).toBe("cancelled");

    // Matches Fix 1's simpler semantics: the INSERT fired before the
    // cancel was visible to the processor, so the result row persists.
    // (The user's DELETE flow is responsible for tidying up if needed.)
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM discovery_results WHERE schedule_id = $1`,
      [scheduleId],
    );
    expect(count.rows[0].count).toBe("1");

    spy.mockRestore();
  });
});
