/**
 * End-to-end HTTP integration tests for /v1/admin/{protocols,campaigns}/*
 * moderation routes.
 *
 * Covers Phase 5 Session 3 plan task 44:
 *
 *   1. Non-admin wallet (valid JWT, not in ADMIN_WALLETS) -> 403
 *   2. Admin wallet pause -> 200, status=paused, audit log row
 *   3. Admin wallet resume -> 200, status=active, audit log row
 *   4. Admin wallet slash -> 200, details.amount + details.reason
 *      persisted, audit log row
 *   5. Admin wallet cooldown -> 200, audit log row
 *   6. Admin wallet campaign pause -> 200 with target_type='campaign'
 *   7. After 6 successful admin calls -> COUNT(*) admin_audit_log = 6
 *
 * The suite also asserts the ADMIN_WALLETS env loading discipline:
 * process.env.ADMIN_WALLETS is set BEFORE any dynamic `import("src/*")`
 * so src/config.ts (which reads the env at module-load time) sees the
 * allowlist and requireAdminAuth can match on it.
 *
 * Gated on `TEST_DATABASE_URL` via describe.skipIf so `pnpm test`
 * still passes on a dev box without a dedicated Postgres.
 */

// -----------------------------------------------------------------------------
// ADMIN_WALLETS env loading discipline (task 44 case 8): set the
// allowlist env var BEFORE any dynamic import("src/*") below. config.ts
// reads process.env at module-load time via zod safeParse, so wallets
// added after the first buildApp() call would not land in the
// allowlist. The leaderboards.e2e.test.ts suite established this same
// pattern — see that file's top-of-module block for prior art.
// -----------------------------------------------------------------------------

const ADMIN_WALLET = "11111111111111111111111111111111"; // 32 chars, base58
const NON_ADMIN_WALLET = "So11111111111111111111111111111111111111112"; // distinct base58

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-admin-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-admin-e2e";
process.env.ADMIN_WALLETS = ADMIN_WALLET;

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

type TestAppModule = typeof import("../helpers/test-app.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let createTestApp: TestAppModule["createTestApp"];
let authHeader: TestAppModule["authHeader"];
let adminAuthHeader: TestAppModule["adminAuthHeader"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

let app: Awaited<ReturnType<TestAppModule["createTestApp"]>>;

const SKIP = !process.env.TEST_DATABASE_URL;

const PROTOCOL_ID = "00000000-0000-0000-0000-000000000b01";

async function seedProtocol(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status, trust_score)
     VALUES ($1, $2, $3, 'active', 5000)`,
    [PROTOCOL_ID, "admin-wallet-seed", "Moderation Target"],
  );
}

async function seedCampaign(): Promise<string> {
  const pool = getTestPool();
  const res = await pool.query<{ campaign_id: string }>(
    `INSERT INTO campaigns (protocol_id, name, action_type, points_per_completion, status)
     VALUES ($1, 'moderation campaign', 'swap', 100, 'live')
     RETURNING campaign_id`,
    [PROTOCOL_ID],
  );
  return res.rows[0].campaign_id;
}

async function countAuditLog(): Promise<number> {
  const pool = getTestPool();
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM admin_audit_log`,
  );
  return Number(res.rows[0].count);
}

describe.skipIf(SKIP)("admin moderation e2e", () => {
  beforeAll(async () => {
    const testApp = await import("../helpers/test-app.js");
    createTestApp = testApp.createTestApp;
    authHeader = testApp.authHeader;
    adminAuthHeader = testApp.adminAuthHeader;

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
  /*  1. Non-admin wallet -> 403                                        */
  /* ------------------------------------------------------------------ */

  it("POST /v1/admin/protocols/:id/pause by non-admin wallet -> 403", async () => {
    await seedProtocol();

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/protocols/${PROTOCOL_ID}/pause`,
      headers: authHeader(NON_ADMIN_WALLET),
      payload: { reason: "unauthorized attempt" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Forbidden");

    // And critically: no audit log row should have been written.
    expect(await countAuditLog()).toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /*  2. Admin pause -> 200 + audit row                                 */
  /* ------------------------------------------------------------------ */

  it("POST /admin/protocols/:id/pause by admin -> 200 with audit log row", async () => {
    await seedProtocol();

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/protocols/${PROTOCOL_ID}/pause`,
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { reason: "investigating incident" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("paused");

    const pool = getTestPool();
    const proto = await pool.query<{ status: string }>(
      `SELECT status FROM protocols WHERE id = $1`,
      [PROTOCOL_ID],
    );
    expect(proto.rows[0].status).toBe("paused");

    const audit = await pool.query<{
      admin_wallet: string;
      action: string;
      target_protocol_id: string | null;
      target_campaign_id: string | null;
      details: { reason: string | null };
    }>(
      `SELECT admin_wallet, action, target_protocol_id, target_campaign_id, details
         FROM admin_audit_log
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].admin_wallet).toBe(ADMIN_WALLET);
    expect(audit.rows[0].action).toBe("protocol.pause");
    expect(audit.rows[0].target_protocol_id).toBe(PROTOCOL_ID);
    expect(audit.rows[0].target_campaign_id).toBeNull();
    expect(audit.rows[0].details.reason).toBe("investigating incident");
  });

  /* ------------------------------------------------------------------ */
  /*  3. Admin resume -> 200 + audit row                                */
  /* ------------------------------------------------------------------ */

  it("POST /admin/protocols/:id/resume by admin -> 200 with audit log row", async () => {
    await seedProtocol();
    // Move it to paused first so resume has something to flip.
    const pool = getTestPool();
    await pool.query(`UPDATE protocols SET status = 'paused' WHERE id = $1`, [
      PROTOCOL_ID,
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/protocols/${PROTOCOL_ID}/resume`,
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { reason: "incident cleared" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("active");

    const proto = await pool.query<{ status: string }>(
      `SELECT status FROM protocols WHERE id = $1`,
      [PROTOCOL_ID],
    );
    expect(proto.rows[0].status).toBe("active");

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM admin_audit_log ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0].action).toBe("protocol.resume");
  });

  /* ------------------------------------------------------------------ */
  /*  4. Admin slash -> 200 + audit row with amount/reason              */
  /* ------------------------------------------------------------------ */

  it("POST /admin/protocols/:id/slash persists amount/reason in audit details", async () => {
    await seedProtocol();

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/protocols/${PROTOCOL_ID}/slash`,
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { amount: "1000", reason: "test slash" },
    });

    expect(res.statusCode).toBe(200);

    const pool = getTestPool();
    const audit = await pool.query<{
      action: string;
      details: { amount: string; reason: string };
    }>(
      `SELECT action, details
         FROM admin_audit_log
        WHERE action = 'protocol.slash'
        LIMIT 1`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].details.amount).toBe("1000");
    expect(audit.rows[0].details.reason).toBe("test slash");
  });

  /* ------------------------------------------------------------------ */
  /*  5. Admin cooldown -> 200 + audit row                              */
  /* ------------------------------------------------------------------ */

  it("POST /admin/protocols/:id/cooldown writes hours + reason to audit details", async () => {
    await seedProtocol();

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/protocols/${PROTOCOL_ID}/cooldown`,
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { hours: 24, reason: "review" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().cooldownHours).toBe(24);

    const pool = getTestPool();
    const audit = await pool.query<{
      action: string;
      details: { hours: number; reason: string; expires_at: string };
    }>(
      `SELECT action, details
         FROM admin_audit_log
        WHERE action = 'protocol.cooldown'
        LIMIT 1`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].details.hours).toBe(24);
    expect(audit.rows[0].details.reason).toBe("review");
    expect(typeof audit.rows[0].details.expires_at).toBe("string");

    const proto = await pool.query<{ status: string }>(
      `SELECT status FROM protocols WHERE id = $1`,
      [PROTOCOL_ID],
    );
    expect(proto.rows[0].status).toBe("cooldown");
  });

  /* ------------------------------------------------------------------ */
  /*  6. Admin campaign pause -> 200 + audit row                        */
  /* ------------------------------------------------------------------ */

  it("POST /admin/campaigns/:id/pause writes audit row with target_campaign_id", async () => {
    await seedProtocol();
    const campaignId = await seedCampaign();

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/campaigns/${campaignId}/pause`,
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: { reason: "quality review" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("paused");

    const pool = getTestPool();
    const audit = await pool.query<{
      action: string;
      target_protocol_id: string | null;
      target_campaign_id: string | null;
    }>(
      `SELECT action, target_protocol_id, target_campaign_id
         FROM admin_audit_log
        WHERE action = 'campaign.pause'
        LIMIT 1`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].target_protocol_id).toBeNull();
    expect(audit.rows[0].target_campaign_id).toBe(campaignId);
  });

  /* ------------------------------------------------------------------ */
  /*  7. Audit log count invariant                                      */
  /* ------------------------------------------------------------------ */

  it("after 6 successful admin calls, admin_audit_log COUNT(*) = 6", async () => {
    await seedProtocol();
    const campaignId = await seedCampaign();

    const calls: Array<Parameters<typeof app.inject>[0]> = [
      {
        method: "POST",
        url: `/v1/admin/protocols/${PROTOCOL_ID}/pause`,
        headers: adminAuthHeader(ADMIN_WALLET),
        payload: { reason: "1" },
      },
      {
        method: "POST",
        url: `/v1/admin/protocols/${PROTOCOL_ID}/resume`,
        headers: adminAuthHeader(ADMIN_WALLET),
        payload: { reason: "2" },
      },
      {
        method: "POST",
        url: `/v1/admin/protocols/${PROTOCOL_ID}/slash`,
        headers: adminAuthHeader(ADMIN_WALLET),
        payload: { amount: "500", reason: "3" },
      },
      {
        method: "POST",
        url: `/v1/admin/protocols/${PROTOCOL_ID}/cooldown`,
        headers: adminAuthHeader(ADMIN_WALLET),
        payload: { hours: 1, reason: "4" },
      },
      {
        method: "POST",
        url: `/v1/admin/campaigns/${campaignId}/pause`,
        headers: adminAuthHeader(ADMIN_WALLET),
        payload: { reason: "5" },
      },
      {
        method: "POST",
        url: `/v1/admin/campaigns/${campaignId}/resume`,
        headers: adminAuthHeader(ADMIN_WALLET),
        payload: { reason: "6" },
      },
    ];

    for (const call of calls) {
      const res = await app.inject(call);
      expect(res.statusCode).toBe(200);
    }

    expect(await countAuditLog()).toBe(6);
  });

  /* ------------------------------------------------------------------ */
  /*  8. ADMIN_WALLETS env loading (discipline assertion)               */
  /* ------------------------------------------------------------------ */

  it("ADMIN_WALLETS env honours allowlist membership", async () => {
    // This case simply re-asserts what (1) already proved via 403 and
    // (2) via 200: config.ts picked up the env var at the top of this
    // module, the admin wallet matches, the non-admin wallet doesn't.
    // The per-test assertions below nail it down without needing to
    // reload config — that would require tearing down the test-db
    // pool and rebuilding the whole app.
    await seedProtocol();

    // Non-admin: 403.
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/admin/protocols/${PROTOCOL_ID}/pause`,
      headers: authHeader(NON_ADMIN_WALLET),
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    // Admin: 200.
    const ok = await app.inject({
      method: "POST",
      url: `/v1/admin/protocols/${PROTOCOL_ID}/pause`,
      headers: adminAuthHeader(ADMIN_WALLET),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
  });
});
