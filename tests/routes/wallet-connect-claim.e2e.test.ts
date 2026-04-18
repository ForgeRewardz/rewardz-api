/**
 * End-to-end HTTP integration tests for POST /v1/campaigns/wallet-connect/claim.
 *
 * Covers Task 13 (mini-app-ux-spec.md §6 — wallet-connect bonus campaign):
 *
 *   1. First claim for a wallet -> 200 { awarded: true, points: 100 }.
 *   2. Second claim for the same wallet -> 200 { awarded: false,
 *      reason: "already_claimed" }. Idempotency proof — ledger must
 *      still only have exactly one point_events row for this wallet.
 *   3. Missing body -> 400.
 *   4. Wallet mismatch (authenticated wallet != body.wallet) -> 403.
 *   5. Campaign paused -> 200 { awarded: false, reason: "campaign_inactive" }.
 *   6. Campaign absent -> 503 { reason: "campaign_not_seeded" }.
 *
 * Gated on `TEST_DATABASE_URL` via describe.skipIf — skips cleanly when
 * unset so `pnpm test` still passes on a dev box without a dedicated
 * Postgres. Mirrors the dynamic-import-in-beforeAll pattern used by
 * campaigns.e2e.test.ts so config.ts zod validation runs against the
 * env values set above.
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
process.env.JWT_SECRET ??= "test-jwt-secret-wallet-connect-claim-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-wallet-connect-e2e";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";

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
/*  Deterministic UUIDs matching scripts/seed-rewardz-protocol.sql            */
/* -------------------------------------------------------------------------- */

const REWARDZ_PROTOCOL_ID = "00000000-0000-4000-8000-000000000001";
const WALLET_CONNECT_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";

/* -------------------------------------------------------------------------- */
/*  ed25519 test keypair helper — mirrors auth.e2e.test.ts                    */
/* -------------------------------------------------------------------------- */

/**
 * Generate a fresh ed25519 keypair and return:
 *   - `walletBase58`: the 32-byte public key rendered as a base58
 *     Solana pubkey (what requireWalletAuth expects in x-wallet-address)
 *   - `sign(message)`: produce a base64-encoded 64-byte signature
 *     over the UTF-8 bytes of `message`, matching what the middleware
 *     verifies with `crypto.verify(null, ...)`.
 */
function generateTestKeypair(): {
  walletBase58: string;
  sign: (message: string) => string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPubKey = spkiDer.subarray(spkiDer.length - 32);
  const walletBase58 = new PublicKey(rawPubKey).toBase58();

  return {
    walletBase58,
    sign: (message: string) =>
      crypto
        .sign(null, Buffer.from(message, "utf8"), privateKey)
        .toString("base64"),
  };
}

/**
 * Build the `x-wallet-address` + `x-wallet-signature` header pair the
 * `requireWalletAuth` middleware verifies. The canonical message is
 * `Sign in to REWARDZ with wallet <walletBase58>` — hard-coded in
 * src/middleware/auth.ts, so any drift there breaks every test.
 */
function walletAuthHeaders(
  kp: ReturnType<typeof generateTestKeypair>,
): Record<string, string> {
  const message = `Sign in to REWARDZ with wallet ${kp.walletBase58}`;
  return {
    "x-wallet-address": kp.walletBase58,
    "x-wallet-signature": kp.sign(message),
  };
}

/* -------------------------------------------------------------------------- */
/*  Seed helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Insert the Rewardz protocol row. Required by the campaigns
 * protocol_id FK — truncateAllTables() wipes it between tests, so each
 * test that needs the campaign row must re-seed both.
 */
async function seedRewardzProtocol(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [REWARDZ_PROTOCOL_ID, "rewardz-platform", "Rewardz"],
  );
}

/**
 * Insert the wallet-connect campaign row. Mirrors the seed SQL at
 * scripts/seed-rewardz-protocol.sql so the tests stay aligned with the
 * production seed invariants (status=active, points=100).
 */
async function seedWalletConnectCampaign(
  overrides: Partial<{
    status: string;
    points_per_completion: number;
  }> = {},
): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO campaigns (
       campaign_id, protocol_id, name, description, action_type,
       points_per_completion, status
     )
     VALUES ($1, $2, 'Wallet Connect Bonus', 'Test seed', 'wallet_connect', $3, $4)
     ON CONFLICT (campaign_id) DO NOTHING`,
    [
      WALLET_CONNECT_CAMPAIGN_ID,
      REWARDZ_PROTOCOL_ID,
      overrides.points_per_completion ?? 100,
      overrides.status ?? "active",
    ],
  );
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                     */
/* -------------------------------------------------------------------------- */

describe.skipIf(SKIP)("POST /v1/campaigns/wallet-connect/claim", () => {
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
  /*  1. First claim — happy path                                       */
  /* ------------------------------------------------------------------ */

  it("first claim for a wallet -> 200 { awarded: true, points: 100 }", async () => {
    await seedRewardzProtocol();
    await seedWalletConnectCampaign();

    const kp = generateTestKeypair();

    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/wallet-connect/claim",
      headers: walletAuthHeaders(kp),
      payload: { wallet: kp.walletBase58 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.awarded).toBe(true);
    expect(body.points).toBe(100);
    expect(body.newBalance).toBe("100");
    expect(typeof body.eventId).toBe("string");

    // Ledger invariant: exactly one point_events row for this wallet
    // under the wallet-connect reference key.
    const pool = getTestPool();
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM point_events
        WHERE source_reference = $1`,
      [`wallet-connect:${kp.walletBase58}`],
    );
    expect(countRes.rows[0].count).toBe("1");
  });

  /* ------------------------------------------------------------------ */
  /*  2. Second claim — idempotent                                      */
  /* ------------------------------------------------------------------ */

  it("second claim for same wallet -> { awarded: false, reason: already_claimed } and no ledger mutation", async () => {
    await seedRewardzProtocol();
    await seedWalletConnectCampaign();

    const kp = generateTestKeypair();
    const headers = walletAuthHeaders(kp);
    const payload = { wallet: kp.walletBase58 };

    const first = await app.inject({
      method: "POST",
      url: "/v1/campaigns/wallet-connect/claim",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().awarded).toBe(true);

    const second = await app.inject({
      method: "POST",
      url: "/v1/campaigns/wallet-connect/claim",
      headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.awarded).toBe(false);
    expect(body.reason).toBe("already_claimed");

    // Still exactly one ledger row.
    const pool = getTestPool();
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM point_events
        WHERE source_reference = $1`,
      [`wallet-connect:${kp.walletBase58}`],
    );
    expect(countRes.rows[0].count).toBe("1");
  });

  /* ------------------------------------------------------------------ */
  /*  3. Missing body -> 400                                            */
  /* ------------------------------------------------------------------ */

  it("missing body -> 400", async () => {
    await seedRewardzProtocol();
    await seedWalletConnectCampaign();

    const kp = generateTestKeypair();

    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/wallet-connect/claim",
      headers: walletAuthHeaders(kp),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Bad Request");
  });

  /* ------------------------------------------------------------------ */
  /*  4. Wallet mismatch -> 403                                         */
  /* ------------------------------------------------------------------ */

  it("wallet mismatch (authenticated wallet != body.wallet) -> 403 and no ledger mutation", async () => {
    await seedRewardzProtocol();
    await seedWalletConnectCampaign();

    const authedKp = generateTestKeypair();
    const otherKp = generateTestKeypair();

    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/wallet-connect/claim",
      headers: walletAuthHeaders(authedKp),
      payload: { wallet: otherKp.walletBase58 },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("wallet_mismatch");

    // No ledger rows for either wallet.
    const pool = getTestPool();
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM point_events
        WHERE source_reference LIKE 'wallet-connect:%'`,
    );
    expect(countRes.rows[0].count).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /*  5. Campaign paused -> campaign_inactive                           */
  /* ------------------------------------------------------------------ */

  it("campaign status=paused -> 200 { awarded: false, reason: campaign_inactive }", async () => {
    await seedRewardzProtocol();
    await seedWalletConnectCampaign({ status: "paused" });

    const kp = generateTestKeypair();

    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/wallet-connect/claim",
      headers: walletAuthHeaders(kp),
      payload: { wallet: kp.walletBase58 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.awarded).toBe(false);
    expect(body.reason).toBe("campaign_inactive");

    // No ledger mutation.
    const pool = getTestPool();
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM point_events`,
    );
    expect(countRes.rows[0].count).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /*  6. Campaign absent -> campaign_not_seeded                         */
  /* ------------------------------------------------------------------ */

  it("campaign row missing -> 503 { reason: campaign_not_seeded }", async () => {
    // Intentionally do NOT seed the campaign row. Seed the protocol
    // so nothing else downstream trips over an FK — the 503 we're
    // proving is specifically the SELECT returning zero rows.
    await seedRewardzProtocol();

    const kp = generateTestKeypair();

    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/wallet-connect/claim",
      headers: walletAuthHeaders(kp),
      payload: { wallet: kp.walletBase58 },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.awarded).toBe(false);
    expect(body.reason).toBe("campaign_not_seeded");
  });
});
