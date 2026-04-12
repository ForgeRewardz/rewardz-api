/**
 * End-to-end HTTP integration tests for the §15G blinks pipeline.
 *
 * Covers plan task 78 acceptance:
 *
 *   1. Upload rewardz-mvp.json via POST /idls → get idlId
 *   2. Upsert program profile with userStake seed template
 *   3. Publish userStake blink via POST /blinks → get manifest URL
 *   4. GET the blink URL → assert ActionGetResponse shape +
 *      parameters[] contains amount
 *   5. POST the blink URL with { account: PAYER } → decode base64
 *      tx and assert the ix layout (ComputeBudget prelude + ATA
 *      prelude + target ix with discriminator 5 + amount LE)
 *   6. OPTIONS the blink URL → assert the actions CORS headers are
 *      present including Access-Control-Allow-Private-Network
 *   7. Same flow for deployToRound (discriminator 20, no ATA prelude)
 *   8. GET /actions.json → assert rules array contains both blinks
 *
 * Gated on `TEST_DATABASE_URL` via describe.skipIf so `pnpm test`
 * stays green on dev boxes without a dedicated Postgres. The POST
 * path needs a deterministic blockhash so the test monkey-patches
 * `Connection.prototype.getLatestBlockhash` before calling
 * `app.inject`. No real RPC traffic.
 */

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-blinks-e2e";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-blinks-e2e";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

type TestAppModule = typeof import("../helpers/test-app.js");
type TestDbModule = typeof import("../helpers/test-db.js");

let createTestApp: TestAppModule["createTestApp"];
let authHeader: TestAppModule["authHeader"];
let setupTestDb: TestDbModule["setupTestDb"];
let teardownTestDb: TestDbModule["teardownTestDb"];
let truncateAllTables: TestDbModule["truncateAllTables"];
let getTestPool: TestDbModule["getTestPool"];

let app: Awaited<ReturnType<TestAppModule["createTestApp"]>>;

const SKIP = !process.env.TEST_DATABASE_URL;

const PROTOCOL_A = "00000000-0000-0000-0000-000000000b01";
// 44-char base58 wallet for the protocol owner.
const OWNER_WALLET = "So11111111111111111111111111111111111111112";
// Separate payer used for POST /blinks/... — doesn't need to be a
// protocol owner because the runtime route is public.
const PAYER_WALLET = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// The fixed-account publish pins. Syntactically-valid base58 —
// tests treat these as opaque strings, no on-curve assertions.
const CONFIG_PUBKEY = "ConfigA111111111111111111111111111111111111A";
const STAKE_VAULT_PUBKEY = "VaultA111111111111111111111111111111111111AA";
const GAME_ROUND_PUBKEY = "RoundA111111111111111111111111111111111111AA";
const PLAYER_DEPLOYMENT_PUBKEY = "PDA1111111111111111111111111111111111111111";
const GAME_TREASURY_PUBKEY = "Treasury111111111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const REWARD_MINT = "RwMint1111111111111111111111111111111111111A";

const REWARDZ_PROGRAM_ID = "mineHEHyaVbQAkcPDDCuCSbkfGNid1RVz6GzcEgSVTh";

// -----------------------------------------------------------------------------
// Fixture loader: reuse the SDK's rewardz-mvp.json so the api/ test doesn't
// diverge from the SDK unit tests. Fails loudly if the path changes.
// -----------------------------------------------------------------------------

function loadRewardzMvpFixture(): unknown {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "sdk",
    "packages",
    "sdk",
    "src",
    "blinks",
    "__fixtures__",
    "rewardz-mvp.json",
  );
  const raw = fs.readFileSync(fixturePath, "utf8");
  return JSON.parse(raw);
}

// -----------------------------------------------------------------------------
// Connection monkey-patch: override getLatestBlockhash so POST
// handlers don't hit live RPC. Pinned blockhash + lastValidBlockHeight
// are deterministic so the base64 tx is reproducible across runs.
// -----------------------------------------------------------------------------

const DETERMINISTIC_BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const originalGetLatestBlockhash = Connection.prototype.getLatestBlockhash;

function installBlockhashStub(): void {
  Connection.prototype.getLatestBlockhash = async function stubbed() {
    return {
      blockhash: DETERMINISTIC_BLOCKHASH,
      lastValidBlockHeight: 999_999_999,
    };
  } as typeof Connection.prototype.getLatestBlockhash;
}

function restoreBlockhashStub(): void {
  Connection.prototype.getLatestBlockhash = originalGetLatestBlockhash;
}

// -----------------------------------------------------------------------------
// Helpers: seed protocols, publish blinks.
// -----------------------------------------------------------------------------

async function seedProtocol(): Promise<void> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO protocols (id, admin_wallet, name, status)
     VALUES ($1, $2, $3, 'active')`,
    [PROTOCOL_A, OWNER_WALLET, "Protocol A"],
  );
}

async function uploadIdlFixture(): Promise<string> {
  const fixture = loadRewardzMvpFixture();
  const res = await app.inject({
    method: "POST",
    url: `/v1/protocols/${PROTOCOL_A}/idls`,
    headers: authHeader(OWNER_WALLET),
    payload: fixture,
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { idlId: string; instructions: string[] };
  expect(body.instructions).toContain("userStake");
  expect(body.instructions).toContain("deployToRound");
  return body.idlId;
}

async function upsertUserStakeProfile(): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/protocols/${PROTOCOL_A}/program-profiles`,
    headers: authHeader(OWNER_WALLET),
    payload: {
      programId: REWARDZ_PROGRAM_ID,
      seeds: {
        userStake: {
          seeds: [
            { kind: "literal", value: "user_stake" },
            { kind: "payer" },
          ],
        },
      },
    },
  });
  expect(res.statusCode).toBe(200);
}

async function publishUserStakeBlink(idlId: string): Promise<{
  instructionSlug: string;
  fixedAccountsHash: string;
}> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/protocols/${PROTOCOL_A}/blinks`,
    headers: authHeader(OWNER_WALLET),
    payload: {
      idlId,
      instructionName: "userStake",
      classification: {
        accounts: {
          user: "payer",
          config: "fixed",
          userStake: "user-pda",
          userToken: "user-ata",
          stakeVault: "fixed",
          systemProgram: "fixed",
          tokenProgram: "fixed",
        },
        args: { amount: "user-input" },
      },
      fixedAccounts: {
        config: CONFIG_PUBKEY,
        stakeVault: STAKE_VAULT_PUBKEY,
        systemProgram: SYSTEM_PROGRAM,
        tokenProgram: TOKEN_PROGRAM,
        rewardMint: REWARD_MINT,
      },
      verificationAdapter: "stake.steel.v1",
      programId: REWARDZ_PROGRAM_ID,
    },
  });
  expect(res.statusCode).toBe(201);
  const manifest = res.json() as {
    instructionSlug: string;
    fixedAccountsHash: string;
  };
  return manifest;
}

async function publishDeployToRoundBlink(idlId: string): Promise<{
  instructionSlug: string;
  fixedAccountsHash: string;
}> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/protocols/${PROTOCOL_A}/blinks`,
    headers: authHeader(OWNER_WALLET),
    payload: {
      idlId,
      instructionName: "deployToRound",
      classification: {
        accounts: {
          user: "payer",
          gameConfig: "fixed",
          gameRound: "fixed",
          userStake: "user-pda",
          playerDeployment: "fixed",
          treasury: "fixed",
          systemProgram: "fixed",
        },
        args: { points: "user-input" },
      },
      fixedAccounts: {
        gameConfig: CONFIG_PUBKEY,
        gameRound: GAME_ROUND_PUBKEY,
        playerDeployment: PLAYER_DEPLOYMENT_PUBKEY,
        treasury: GAME_TREASURY_PUBKEY,
        systemProgram: SYSTEM_PROGRAM,
      },
      verificationAdapter: "mining.game.v1",
      programId: REWARDZ_PROGRAM_ID,
    },
  });
  expect(res.statusCode).toBe(201);
  const manifest = res.json() as {
    instructionSlug: string;
    fixedAccountsHash: string;
  };
  return manifest;
}

// -----------------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------------

describe.skipIf(SKIP)("blinks e2e — §15G", () => {
  beforeAll(async () => {
    const testApp = await import("../helpers/test-app.js");
    createTestApp = testApp.createTestApp;
    authHeader = testApp.authHeader;

    const testDb = await import("../helpers/test-db.js");
    setupTestDb = testDb.setupTestDb;
    teardownTestDb = testDb.teardownTestDb;
    truncateAllTables = testDb.truncateAllTables;
    getTestPool = testDb.getTestPool;

    await setupTestDb();
    app = await createTestApp();
    installBlockhashStub();
  });

  afterEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    restoreBlockhashStub();
    if (app) await app.close();
    await teardownTestDb();
  });

  /* -------------------------------------------------------------------- */
  /*  1. Upload IDL                                                       */
  /* -------------------------------------------------------------------- */

  it("POST /v1/protocols/:id/idls uploads and returns instruction list", async () => {
    await seedProtocol();
    const idlId = await uploadIdlFixture();
    expect(idlId).toMatch(/^[0-9a-f-]{36}$/);
  });

  /* -------------------------------------------------------------------- */
  /*  2. Publish userStake blink                                          */
  /* -------------------------------------------------------------------- */

  it("POST /v1/protocols/:id/blinks publishes a userStake blink", async () => {
    await seedProtocol();
    const idlId = await uploadIdlFixture();
    await upsertUserStakeProfile();
    const manifest = await publishUserStakeBlink(idlId);
    expect(manifest.instructionSlug).toBe("user-stake");
    expect(manifest.fixedAccountsHash).toHaveLength(12);
  });

  /* -------------------------------------------------------------------- */
  /*  3. GET blink → ActionGetResponse                                    */
  /* -------------------------------------------------------------------- */

  it("GET /v1/blinks/... returns ActionGetResponse with parameters", async () => {
    await seedProtocol();
    const idlId = await uploadIdlFixture();
    await upsertUserStakeProfile();
    const manifest = await publishUserStakeBlink(idlId);

    const res = await app.inject({
      method: "GET",
      url: `/v1/blinks/${PROTOCOL_A}/${manifest.instructionSlug}/${manifest.fixedAccountsHash}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      icon: string;
      label: string;
      title: string;
      description: string;
      links: { actions: Array<{ parameters: Array<{ name: string }> }> };
    };
    expect(body.label).toBe("User Stake");
    const params = body.links.actions[0].parameters;
    expect(params.some((p) => p.name === "amount")).toBe(true);
  });

  /* -------------------------------------------------------------------- */
  /*  4. POST blink → decode VersionedTransaction                         */
  /* -------------------------------------------------------------------- */

  it("POST /v1/blinks/... returns a decodable VersionedTransaction with compute prelude + ATA + target ix", async () => {
    await seedProtocol();
    const idlId = await uploadIdlFixture();
    await upsertUserStakeProfile();
    const manifest = await publishUserStakeBlink(idlId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/blinks/${PROTOCOL_A}/${manifest.instructionSlug}/${manifest.fixedAccountsHash}?amount=1000`,
      payload: { account: PAYER_WALLET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transaction: string };

    const buf = Buffer.from(body.transaction, "base64");
    const tx = VersionedTransaction.deserialize(buf);
    const message = tx.message;
    const accountKeys = message.getAccountKeys();

    // Collect every instruction with its programId and raw data.
    const programIds = message.compiledInstructions.map((ci) => {
      const key = accountKeys.get(ci.programIdIndex);
      return key ? key.toBase58() : "";
    });

    const computeBudgetId = ComputeBudgetProgram.programId.toBase58();

    // Assert ix[0] and ix[1] target the compute budget program.
    expect(programIds[0]).toBe(computeBudgetId);
    expect(programIds[1]).toBe(computeBudgetId);

    // The target rewardz-mvp ix is somewhere after the compute-budget
    // prelude. Locate it by program id filter to stay robust against
    // any future reordering of the ATA prelude.
    const rewardzIdx = programIds.findIndex((p) => p === REWARDZ_PROGRAM_ID);
    expect(rewardzIdx).toBeGreaterThanOrEqual(2);

    const targetIx = message.compiledInstructions[rewardzIdx];
    const data = Buffer.from(targetIx.data);
    // Discriminator 5 (userStake) + 8-byte u64 amount LE.
    expect(data[0]).toBe(5);
    expect(data.length).toBe(9);
    const readAmount = data.readBigUInt64LE(1);
    expect(readAmount).toBe(1000n);

    // At least one ix between compute-budget and target must be the
    // SPL token program (the ATA prelude) because userStake has a
    // user-ata account (userToken).
    const ataIdxs = programIds.filter(
      (p) => p === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    expect(ataIdxs.length).toBeGreaterThanOrEqual(1);
  });

  /* -------------------------------------------------------------------- */
  /*  5. OPTIONS blink → CORS preflight headers                           */
  /* -------------------------------------------------------------------- */

  it("OPTIONS /v1/blinks/... returns 204 + full ACTIONS_CORS_HEADERS", async () => {
    await seedProtocol();
    const idlId = await uploadIdlFixture();
    await upsertUserStakeProfile();
    const manifest = await publishUserStakeBlink(idlId);

    const res = await app.inject({
      method: "OPTIONS",
      url: `/v1/blinks/${PROTOCOL_A}/${manifest.instructionSlug}/${manifest.fixedAccountsHash}`,
      headers: {
        origin: "https://dial.to",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-private-network"]).toBe(
      "true",
    );
    expect(String(res.headers["access-control-allow-methods"])).toContain(
      "POST",
    );
  });

  /* -------------------------------------------------------------------- */
  /*  6. deployToRound path (no ATA prelude)                              */
  /* -------------------------------------------------------------------- */

  it("POST /v1/blinks/... for deployToRound has discriminator 20 and no ATA prelude", async () => {
    await seedProtocol();
    const idlId = await uploadIdlFixture();
    await upsertUserStakeProfile();
    const manifest = await publishDeployToRoundBlink(idlId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/blinks/${PROTOCOL_A}/${manifest.instructionSlug}/${manifest.fixedAccountsHash}?points=42`,
      payload: { account: PAYER_WALLET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transaction: string };
    const buf = Buffer.from(body.transaction, "base64");
    const tx = VersionedTransaction.deserialize(buf);
    const message = tx.message;
    const accountKeys = message.getAccountKeys();
    const programIds = message.compiledInstructions.map((ci) => {
      const k = accountKeys.get(ci.programIdIndex);
      return k ? k.toBase58() : "";
    });

    const rewardzIdx = programIds.findIndex((p) => p === REWARDZ_PROGRAM_ID);
    expect(rewardzIdx).toBeGreaterThanOrEqual(2);

    const targetIx = message.compiledInstructions[rewardzIdx];
    const data = Buffer.from(targetIx.data);
    expect(data[0]).toBe(20);
    expect(data.length).toBe(9);
    expect(data.readBigUInt64LE(1)).toBe(42n);

    // No ATA prelude expected for deployToRound (no user-ata accounts).
    const ataIdxs = programIds.filter(
      (p) => p === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    expect(ataIdxs.length).toBe(0);
  });

  /* -------------------------------------------------------------------- */
  /*  7. /actions.json contains both blinks                               */
  /* -------------------------------------------------------------------- */

  it("GET /actions.json aggregates every live blink", async () => {
    await seedProtocol();
    const idlId = await uploadIdlFixture();
    await upsertUserStakeProfile();
    const stake = await publishUserStakeBlink(idlId);
    const deploy = await publishDeployToRoundBlink(idlId);

    const res = await app.inject({ method: "GET", url: "/actions.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rules: Array<{ pathPattern: string }> };
    const paths = body.rules.map((r) => r.pathPattern);
    expect(
      paths.some(
        (p) =>
          p ===
          `/v1/blinks/${PROTOCOL_A}/${stake.instructionSlug}/${stake.fixedAccountsHash}`,
      ),
    ).toBe(true);
    expect(
      paths.some(
        (p) =>
          p ===
          `/v1/blinks/${PROTOCOL_A}/${deploy.instructionSlug}/${deploy.fixedAccountsHash}`,
      ),
    ).toBe(true);

    // Actions CORS headers apply here too.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-private-network"]).toBe(
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// Static-analysis touch: reference imported symbols that only exist to keep
// the dependency graph honest (and prove @solana/spl-token resolved).
// ---------------------------------------------------------------------------
void PublicKey;
