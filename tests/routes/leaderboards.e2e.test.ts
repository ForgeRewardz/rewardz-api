/**
 * End-to-end HTTP integration tests for the leaderboards surface.
 *
 * Exercises the full request → route → service → db → response loop
 * via `fastify.inject` (no HTTP socket binding). Complements the unit
 * tests in `tests/services/leaderboard-service.test.ts` which hit the
 * service functions directly.
 *
 * Covers Phase 5 Session 2 plan task 22:
 *   1.  GET /v1/leaderboard/season returns the active season
 *   2.  Season-score upserts fire across api/webhook/blink channels
 *   3.  `completion` channel folds into blink_points (not a separate col)
 *   4.  Tweet channel plumbing works (prod call-site lands in Phase 9)
 *   5.  Null protocolId gracefully degrades — no season rollup fires
 *   6.  GET /v1/leaderboard/protocols returns the TODO-0016 wire shape
 *   7.  GET /v1/leaderboard/users returns ranked user entries
 *   8.  POST /v1/admin/leaderboards/snapshot rejects non-admin (403)
 *   9.  POST /v1/admin/leaderboards/snapshot succeeds for admin wallet
 *   10. Repeated admin snapshot returns 409 (pre-check in admin route)
 *
 * Gated on `TEST_DATABASE_URL` via describe.skipIf — skips cleanly
 * when unset so `pnpm test` still passes on a dev box without a
 * dedicated Postgres.
 */

// -----------------------------------------------------------------------------
// Env setup MUST happen before any dynamic `import("src/*")` call below.
//
// `src/config.ts` validates with zod + process.exit at module load time, so
// JWT_SECRET / INTERNAL_API_KEY must be present before buildApp() is imported.
// `DATABASE_URL` is pointed at the test DB so service-layer `query()` calls
// hit the same database the test harness migrated.
//
// `ADMIN_WALLETS` must be a base58 Solana pubkey (config.ts regex). We set it
// here so the admin-gated snapshot endpoint accepts ADMIN_WALLET below. The
// non-admin wallet is a distinct base58 string that is NOT in the allowlist,
// so `requireAdminAuth` returns 403 for it.
//
// Note: ESM hoists static imports above this block, but assignments to
// `process.env` run before any dynamic `await import(...)` inside
// `beforeAll` because the describe body doesn't execute until after the
// module top level has finished.
// -----------------------------------------------------------------------------

const ADMIN_WALLET = "11111111111111111111111111111111"; // 32 chars, base58
const NON_ADMIN_WALLET = "So11111111111111111111111111111111111111112"; // 44 chars, base58

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-leaderboards-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-leaderboards-e2e";
process.env.ADMIN_WALLETS = ADMIN_WALLET;

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

type TestAppModule = typeof import("../helpers/test-app.js");
type TestDbModule = typeof import("../helpers/test-db.js");
type PointsServiceModule =
  typeof import("../../src/services/points-service.js");

let createTestApp: TestAppModule["createTestApp"];
let adminAuthHeader: TestAppModule["adminAuthHeader"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];
let awardPoints: PointsServiceModule["awardPoints"];

let app: Awaited<ReturnType<TestAppModule["createTestApp"]>>;

const SKIP = !process.env.TEST_DATABASE_URL;

// Fixed UUIDs so assertions can reference them without round-tripping
// through the DB. All protocols + seasons use the 0000-...-XX pattern to
// keep them visually grouped.
const SEASON_ID = "00000000-0000-0000-0000-0000000000e1";
const PROTOCOL_JUPITER = "00000000-0000-0000-0000-000000000101";
const PROTOCOL_ORCA = "00000000-0000-0000-0000-000000000102";
const PROTOCOL_METEORA = "00000000-0000-0000-0000-000000000103";
const PROTOCOL_GENERIC = "00000000-0000-0000-0000-0000000001f0";

/* -------------------------------------------------------------------------- */
/*  Test fixtures                                                             */
/* -------------------------------------------------------------------------- */

async function seedActiveSeason(
  name = "Airdrop Season 1 — Whitelisting",
): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO leaderboard_seasons (id, name, start_at, end_at, is_active, snapshot_taken)
     VALUES ($1, $2, NOW(), NULL, TRUE, FALSE)`,
    [SEASON_ID, name],
  );
}

async function seedGenericProtocol(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status)
     VALUES ($1, $2, $3, 'active')`,
    [PROTOCOL_GENERIC, "admin-wallet-generic", "Generic Protocol"],
  );
}

async function seedThreeProtocols(): Promise<void> {
  const pool = getTestPool();
  for (const [id, name, wallet] of [
    [PROTOCOL_JUPITER, "Jupiter", "admin-wallet-jupiter"],
    [PROTOCOL_ORCA, "Orca", "admin-wallet-orca"],
    [PROTOCOL_METEORA, "Meteora", "admin-wallet-meteora"],
  ]) {
    await pool.query(
      `INSERT INTO protocols (id, admin_wallet, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [id, wallet, name],
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                     */
/* -------------------------------------------------------------------------- */

describe.skipIf(SKIP)("leaderboards e2e", () => {
  beforeAll(async () => {
    // Defer module loading until AFTER env vars are configured — ESM
    // hoists static imports above the `process.env.*` assignments at
    // the top of the file, but dynamic imports inside a hook run after.
    const testApp = await import("../helpers/test-app.js");
    createTestApp = testApp.createTestApp;
    adminAuthHeader = testApp.adminAuthHeader;

    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    const pointsService = await import("../../src/services/points-service.js");
    awardPoints = pointsService.awardPoints;

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
  /*  1. GET /v1/leaderboard/season                                     */
  /* ------------------------------------------------------------------ */

  it("GET /v1/leaderboard/season returns the active season", async () => {
    await seedActiveSeason();

    const res = await app.inject({
      method: "GET",
      url: "/v1/leaderboard/season",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seasonId).toBe(SEASON_ID);
    expect(body.name).toBe("Airdrop Season 1 — Whitelisting");
    expect(body.status).toBe("active");
    expect(body.snapshotTaken).toBe(false);
    expect(body.endAt).toBeNull();
    expect(typeof body.startAt).toBe("string");
  });

  /* ------------------------------------------------------------------ */
  /*  2. Season-score upserts across api / webhook / blink              */
  /* ------------------------------------------------------------------ */

  it("awardPoints fires season-score hooks across api/webhook/blink channels", async () => {
    await seedActiveSeason();
    await seedGenericProtocol();

    await awardPoints(
      "wallet-1",
      100n,
      PROTOCOL_GENERIC,
      { type: "reference", key: "api-1" },
      "api award",
      "api",
    );
    await awardPoints(
      "wallet-2",
      200n,
      PROTOCOL_GENERIC,
      { type: "reference", key: "webhook-1" },
      "webhook award",
      "webhook",
    );
    await awardPoints(
      "wallet-3",
      300n,
      PROTOCOL_GENERIC,
      { type: "signature", key: "sig-1" },
      "blink award",
      "blink",
    );

    const pool = getTestPool();

    // point_events should have 3 rows with matching channel classifications.
    const events = await pool.query<{ channel: string; amount: string }>(
      `SELECT channel, amount::text AS amount
         FROM point_events
        ORDER BY amount ASC`,
    );
    expect(events.rowCount).toBe(3);
    expect(events.rows.map((r) => r.channel)).toEqual([
      "api",
      "webhook",
      "blink",
    ]);

    // protocol_scores should have ONE row for (season, protocol) with the
    // correct per-channel breakdown and total.
    const protoScore = await pool.query<{
      total_points_issued: string;
      tweet_points: string;
      api_points: string;
      webhook_points: string;
      blink_points: string;
      unique_users_rewarded: number;
    }>(
      `SELECT total_points_issued::text AS total_points_issued,
              tweet_points::text        AS tweet_points,
              api_points::text          AS api_points,
              webhook_points::text      AS webhook_points,
              blink_points::text        AS blink_points,
              unique_users_rewarded
         FROM protocol_scores
        WHERE season_id = $1 AND protocol_id = $2`,
      [SEASON_ID, PROTOCOL_GENERIC],
    );
    expect(protoScore.rowCount).toBe(1);
    expect(protoScore.rows[0].total_points_issued).toBe("600");
    expect(protoScore.rows[0].api_points).toBe("100");
    expect(protoScore.rows[0].webhook_points).toBe("200");
    expect(protoScore.rows[0].blink_points).toBe("300");
    expect(protoScore.rows[0].tweet_points).toBe("0");
    expect(protoScore.rows[0].unique_users_rewarded).toBe(3);

    // user_season_scores should have one row per wallet with its channel
    // rolled up into the correct column.
    const userScores = await pool.query<{
      user_wallet: string;
      total_points: string;
      api_points: string;
      webhook_points: string;
      blink_points: string;
    }>(
      `SELECT user_wallet,
              total_points::text   AS total_points,
              api_points::text     AS api_points,
              webhook_points::text AS webhook_points,
              blink_points::text   AS blink_points
         FROM user_season_scores
        WHERE season_id = $1
        ORDER BY user_wallet`,
      [SEASON_ID],
    );
    expect(userScores.rowCount).toBe(3);
    const w1 = userScores.rows.find((r) => r.user_wallet === "wallet-1");
    const w2 = userScores.rows.find((r) => r.user_wallet === "wallet-2");
    const w3 = userScores.rows.find((r) => r.user_wallet === "wallet-3");
    expect(w1?.total_points).toBe("100");
    expect(w1?.api_points).toBe("100");
    expect(w2?.total_points).toBe("200");
    expect(w2?.webhook_points).toBe("200");
    expect(w3?.total_points).toBe("300");
    expect(w3?.blink_points).toBe("300");
  });

  /* ------------------------------------------------------------------ */
  /*  3. `completion` channel folds into blink_points                   */
  /* ------------------------------------------------------------------ */

  it("completion channel folds into blink_points (no separate column)", async () => {
    await seedActiveSeason();
    await seedGenericProtocol();

    await awardPoints(
      "wallet-comp",
      500n,
      PROTOCOL_GENERIC,
      { type: "completion", key: "comp-1" },
      "completion award",
      "completion",
    );

    const pool = getTestPool();
    const row = await pool.query<{
      total_points_issued: string;
      api_points: string;
      webhook_points: string;
      blink_points: string;
      tweet_points: string;
    }>(
      `SELECT total_points_issued::text AS total_points_issued,
              api_points::text          AS api_points,
              webhook_points::text      AS webhook_points,
              blink_points::text        AS blink_points,
              tweet_points::text        AS tweet_points
         FROM protocol_scores
        WHERE season_id = $1 AND protocol_id = $2`,
      [SEASON_ID, PROTOCOL_GENERIC],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].total_points_issued).toBe("500");
    expect(row.rows[0].blink_points).toBe("500");
    expect(row.rows[0].api_points).toBe("0");
    expect(row.rows[0].webhook_points).toBe("0");
    expect(row.rows[0].tweet_points).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /*  4. Tweet channel plumbing                                         */
  /* ------------------------------------------------------------------ */

  it("tweet channel plumbing bumps tweet_points when awardPoints is called with channel='tweet'", async () => {
    // NOTE: routes/x-post.ts does NOT call awardPoints in prod today —
    // this test proves the channel plumbing will work once upstream
    // wiring lands (Phase 9). Until then the tweet column stays at 0
    // in production because no call-site ever bumps it.
    await seedActiveSeason();
    await seedGenericProtocol();

    await awardPoints(
      "wallet-tweet",
      100n,
      PROTOCOL_GENERIC,
      { type: "reference", key: "tweet-1" },
      "tweet award",
      "tweet",
    );

    const pool = getTestPool();
    const row = await pool.query<{
      total_points_issued: string;
      tweet_points: string;
      api_points: string;
      webhook_points: string;
      blink_points: string;
    }>(
      `SELECT total_points_issued::text AS total_points_issued,
              tweet_points::text        AS tweet_points,
              api_points::text          AS api_points,
              webhook_points::text      AS webhook_points,
              blink_points::text        AS blink_points
         FROM protocol_scores
        WHERE season_id = $1 AND protocol_id = $2`,
      [SEASON_ID, PROTOCOL_GENERIC],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].total_points_issued).toBe("100");
    expect(row.rows[0].tweet_points).toBe("100");
    expect(row.rows[0].api_points).toBe("0");
    expect(row.rows[0].webhook_points).toBe("0");
    expect(row.rows[0].blink_points).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /*  5. Null protocolId gracefully degrades                            */
  /* ------------------------------------------------------------------ */

  it("awardPoints with null protocolId does NOT fire season rollup hooks", async () => {
    // Per plan R3: unresolved zealy webhooks (null protocolId) must
    // still mint a point_event but MUST NOT touch protocol_scores.
    // G2's implementation wraps BOTH upsertProtocolScore and
    // upsertUserSeasonScore in `if (protocolId !== null)`, so
    // user_season_scores also stays empty when protocolId is null.
    await seedActiveSeason();
    // Intentionally no protocol seeded — null protocolId means the
    // webhook ingester couldn't resolve an attribution.

    await awardPoints(
      "wallet-zealy",
      100n,
      null,
      { type: "reference", key: "zealy-1" },
      "unresolved zealy webhook",
      "webhook",
    );

    const pool = getTestPool();

    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM point_events`,
    );
    expect(events.rows[0].count).toBe("1");

    const protoScores = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM protocol_scores`,
    );
    expect(protoScores.rows[0].count).toBe("0");

    const userScores = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_season_scores`,
    );
    expect(userScores.rows[0].count).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /*  6. GET /v1/leaderboard/protocols                                  */
  /* ------------------------------------------------------------------ */

  it("GET /v1/leaderboard/protocols returns ranked entries in TODO-0016 wire shape", async () => {
    await seedActiveSeason();
    await seedThreeProtocols();

    // Seed different totals so ranking is unambiguous:
    //   Jupiter = 1000 (rank 1), Orca = 500 (rank 2), Meteora = 250 (rank 3)
    await awardPoints(
      "wallet-jup",
      1000n,
      PROTOCOL_JUPITER,
      { type: "reference", key: "lb-protos-jup" },
      "jupiter",
      "api",
    );
    await awardPoints(
      "wallet-orca",
      500n,
      PROTOCOL_ORCA,
      { type: "reference", key: "lb-protos-orca" },
      "orca",
      "webhook",
    );
    await awardPoints(
      "wallet-meteora",
      250n,
      PROTOCOL_METEORA,
      { type: "reference", key: "lb-protos-meteora" },
      "meteora",
      "blink",
    );

    const res = await app.inject({
      method: "GET",
      url: "/v1/leaderboard/protocols?limit=10&page=1",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.seasonId).toBe(SEASON_ID);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(3);

    const [first, second, third] = body.entries;
    expect(first.rank).toBe(1);
    expect(first.protocolId).toBe(PROTOCOL_JUPITER);
    expect(first.protocolName).toBe("Jupiter");
    expect(first.protocolLogo).toBeNull();
    expect(first.totalPointsIssued).toBe("1000");
    expect(typeof first.totalPointsIssued).toBe("string");
    // Breakdown columns are all strings even when zero.
    expect(first.breakdown).toEqual({
      tweet: "0",
      api: "1000",
      webhook: "0",
      blink: "0",
    });

    expect(second.rank).toBe(2);
    expect(second.protocolId).toBe(PROTOCOL_ORCA);
    expect(second.totalPointsIssued).toBe("500");
    expect(second.breakdown.webhook).toBe("500");

    expect(third.rank).toBe(3);
    expect(third.protocolId).toBe(PROTOCOL_METEORA);
    expect(third.totalPointsIssued).toBe("250");
    expect(third.breakdown.blink).toBe("250");
  });

  /* ------------------------------------------------------------------ */
  /*  7. GET /v1/leaderboard/users                                      */
  /* ------------------------------------------------------------------ */

  it("GET /v1/leaderboard/users returns ranked user entries", async () => {
    await seedActiveSeason();
    await seedThreeProtocols();

    // Three wallets, each getting points under a different protocol so
    // the user-leaderboard can order them by total_points.
    await awardPoints(
      "wallet-alpha",
      800n,
      PROTOCOL_JUPITER,
      { type: "reference", key: "users-alpha" },
      "alpha",
      "api",
    );
    await awardPoints(
      "wallet-bravo",
      400n,
      PROTOCOL_ORCA,
      { type: "reference", key: "users-bravo" },
      "bravo",
      "api",
    );
    await awardPoints(
      "wallet-charlie",
      150n,
      PROTOCOL_METEORA,
      { type: "reference", key: "users-charlie" },
      "charlie",
      "api",
    );

    const res = await app.inject({
      method: "GET",
      url: "/v1/leaderboard/users?limit=10&page=1",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.seasonId).toBe(SEASON_ID);
    expect(body.entries).toHaveLength(3);

    const [first, second, third] = body.entries;
    expect(first.rank).toBe(1);
    expect(first.wallet).toBe("wallet-alpha");
    expect(first.totalPoints).toBe("800");
    expect(typeof first.totalPoints).toBe("string");
    expect(first.breakdown).toEqual({
      tweet: "0",
      api: "800",
      webhook: "0",
      blink: "0",
    });

    expect(second.rank).toBe(2);
    expect(second.wallet).toBe("wallet-bravo");
    expect(Number(first.totalPoints)).toBeGreaterThan(
      Number(second.totalPoints),
    );

    expect(third.rank).toBe(3);
    expect(third.wallet).toBe("wallet-charlie");
  });

  /* ------------------------------------------------------------------ */
  /*  8. POST /v1/admin/leaderboards/snapshot — non-admin → 403         */
  /* ------------------------------------------------------------------ */

  it("POST /v1/admin/leaderboards/snapshot returns 403 for a non-admin wallet", async () => {
    await seedActiveSeason();

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/leaderboards/snapshot",
      headers: adminAuthHeader(NON_ADMIN_WALLET),
      payload: { seasonId: SEASON_ID },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("Forbidden");
  });

  /* ------------------------------------------------------------------ */
  /*  9. POST /v1/admin/leaderboards/snapshot — admin wallet → 200      */
  /* ------------------------------------------------------------------ */

  it("POST /v1/admin/leaderboards/snapshot succeeds for an admin wallet and writes snapshot rows", async () => {
    await seedActiveSeason();

    // Seed 5 protocols so protocolsSnapshotted === 5.
    const pool = getTestPool();
    const protoIds = [
      "00000000-0000-0000-0000-000000000201",
      "00000000-0000-0000-0000-000000000202",
      "00000000-0000-0000-0000-000000000203",
      "00000000-0000-0000-0000-000000000204",
      "00000000-0000-0000-0000-000000000205",
    ];
    for (let i = 0; i < protoIds.length; i++) {
      await pool.query(
        `INSERT INTO protocols (id, admin_wallet, name, status)
         VALUES ($1, $2, $3, 'active')`,
        [protoIds[i], `admin-wallet-proto-${i}`, `Proto ${i}`],
      );
    }

    // 10 wallets, each awarded under one of the 5 protocols (2 wallets
    // per protocol) with varying amounts so the snapshot ordering is
    // deterministic but the exact ranks don't matter — we just need
    // 5 protocol rows + 10 user rows in the output.
    for (let u = 0; u < 10; u++) {
      const proto = protoIds[u % protoIds.length];
      const amount = BigInt(100 * (u + 1));
      await awardPoints(
        `wallet-snap-${u}`,
        amount,
        proto,
        { type: "reference", key: `snap-ref-${u}` },
        `snap ${u}`,
        "api",
      );
    }

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/leaderboards/snapshot",
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { seasonId: SEASON_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seasonId).toBe(SEASON_ID);
    expect(body.protocolsSnapshotted).toBe(5);
    expect(body.usersSnapshotted).toBe(10);

    // leaderboard_snapshots should have 15 rows total (5 protocol + 10 user).
    const snapCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM leaderboard_snapshots
        WHERE season_id = $1`,
      [SEASON_ID],
    );
    expect(snapCount.rows[0].count).toBe("15");

    const seasonRow = await pool.query<{ snapshot_taken: boolean }>(
      `SELECT snapshot_taken FROM leaderboard_seasons WHERE id = $1`,
      [SEASON_ID],
    );
    expect(seasonRow.rows[0].snapshot_taken).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  10. Repeated snapshot → 409 Conflict                              */
  /* ------------------------------------------------------------------ */

  it("POST /v1/admin/leaderboards/snapshot returns 409 on a second call (admin pre-check)", async () => {
    await seedActiveSeason();
    await seedGenericProtocol();

    await awardPoints(
      "wallet-idempotent",
      100n,
      PROTOCOL_GENERIC,
      { type: "reference", key: "idempotent-1" },
      "idempotent",
      "api",
    );

    // First call: success.
    const first = await app.inject({
      method: "POST",
      url: "/v1/admin/leaderboards/snapshot",
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { seasonId: SEASON_ID },
    });
    expect(first.statusCode).toBe(200);

    // Second call: the admin route pre-checks `snapshot_taken` and
    // returns 409 without re-running takeSnapshot() (see
    // src/routes/admin.ts — the service itself is idempotent, but the
    // route surfaces the conflict to clients so they don't silently
    // re-run expensive operations).
    const second = await app.inject({
      method: "POST",
      url: "/v1/admin/leaderboards/snapshot",
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { seasonId: SEASON_ID },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toBe("Conflict");
  });
});
