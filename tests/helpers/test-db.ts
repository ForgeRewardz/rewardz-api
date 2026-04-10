/**
 * Test DB harness for Phase 5 integration tests.
 *
 * Strategy: connect to a dedicated test Postgres database specified by
 * the `TEST_DATABASE_URL` env var. We do NOT spawn an ephemeral cluster
 * here — keeping it an env-var contract means a developer can point at a
 * local Postgres, a docker-compose instance, or a throwaway CI database
 * without any helper changes.
 *
 * Usage in a test file:
 *
 *     import {
 *       setupTestDb,
 *       teardownTestDb,
 *       truncateAllTables,
 *     } from "./helpers/test-db.js";
 *
 *     beforeAll(async () => {
 *       await setupTestDb();
 *     });
 *
 *     afterEach(async () => {
 *       await truncateAllTables();
 *     });
 *
 *     afterAll(async () => {
 *       await teardownTestDb();
 *     });
 *
 * Tests that don't need a database should not import this file — the
 * connection pool is only created on first `setupTestDb()` call.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "src",
  "db",
  "migrations",
);

/**
 * Shared pool used by all helpers. `null` until `setupTestDb` has been
 * called at least once in this process.
 */
let pool: pg.Pool | null = null;

/**
 * Return the active test pool. Throws if `setupTestDb` has not been
 * called — callers should always invoke `setupTestDb` from a
 * `beforeAll` hook before using any other helper.
 */
export function getTestPool(): pg.Pool {
  if (!pool) {
    throw new Error(
      "Test DB pool not initialised. Call setupTestDb() in a beforeAll hook before using any DB helper.",
    );
  }
  return pool;
}

/**
 * Connect to the test database and apply every migration in
 * `src/db/migrations/`. Safe to call multiple times — subsequent calls
 * reuse the existing pool.
 *
 * Reads `TEST_DATABASE_URL` from the environment. Falls back to
 * `DATABASE_URL` when unset to support single-database local setups,
 * but prints a loud warning because destructive operations (truncate,
 * drop) will run against that database.
 */
export async function setupTestDb(): Promise<pg.Pool> {
  if (pool) {
    return pool;
  }

  const connectionString =
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "Neither TEST_DATABASE_URL nor DATABASE_URL is set — refusing to run tests without an explicit test database.",
    );
  }

  if (!process.env.TEST_DATABASE_URL) {
    // biome-ignore lint/suspicious/noConsole: helper warning
    console.warn(
      "[test-db] TEST_DATABASE_URL not set — falling back to DATABASE_URL. truncateAllTables()/teardownTestDb() will wipe data in that database.",
    );
  }

  pool = new Pool({ connectionString });

  await ensureMigrationsTable(pool);
  await applyMigrations(pool);

  return pool;
}

/**
 * Close the test pool. After this the helpers cannot be used again in
 * the same process unless `setupTestDb` is called once more.
 */
export async function teardownTestDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/**
 * Truncate every user table (everything except the internal
 * `_migrations` bookkeeping table). Intended for per-test cleanup so
 * tests can run in any order without leaking state.
 *
 * Uses a single `TRUNCATE ... RESTART IDENTITY CASCADE` statement so
 * foreign keys don't need to be dropped.
 */
export async function truncateAllTables(): Promise<void> {
  const p = getTestPool();
  const result = await p.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('_migrations')`,
  );

  if (result.rowCount === 0) return;

  const tableList = result.rows.map((row) => `"${row.tablename}"`).join(", ");
  await p.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

/**
 * Drop every table (including `_migrations`). Meant for the rare case
 * where a test needs to force a full re-run of migrations — most tests
 * should prefer `truncateAllTables`.
 */
export async function dropAllTables(): Promise<void> {
  const p = getTestPool();
  const result = await p.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'`,
  );

  if (result.rowCount === 0) return;

  const tableList = result.rows.map((row) => `"${row.tablename}"`).join(", ");
  await p.query(`DROP TABLE IF EXISTS ${tableList} CASCADE`);
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

async function ensureMigrationsTable(p: pg.Pool): Promise<void> {
  await p.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function applyMigrations(p: pg.Pool): Promise<void> {
  const applied = await p.query<{ name: string }>(
    "SELECT name FROM _migrations",
  );
  const appliedSet = new Set(applied.rows.map((r) => r.name));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `Test DB migration failed at ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      client.release();
    }
  }
}
