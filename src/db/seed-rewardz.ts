import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";

/**
 * Apply `api/scripts/seed-rewardz-protocol.sql` against DATABASE_URL using
 * the same pg pool as migrate.ts. The seed itself is idempotent
 * (`ON CONFLICT DO NOTHING`) so re-running is safe.
 *
 * This exists as a tsx runner instead of a host `psql -f …` invocation so
 * bootstrap-local.sh / setup.sh don't need psql on the host machine. The
 * mini-app-specific Rewardz protocol + wallet-connect campaign rows are
 * required by `POST /v1/campaigns/wallet-connect/claim` — without them the
 * route returns `{awarded: false, reason: "campaign_not_seeded"}`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/db/seed-rewardz.ts → api/scripts/seed-rewardz-protocol.sql
const SEED_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "scripts",
  "seed-rewardz-protocol.sql",
);

async function main(): Promise<void> {
  if (!fs.existsSync(SEED_PATH)) {
    throw new Error(`Seed file not found at ${SEED_PATH}`);
  }
  const sql = fs.readFileSync(SEED_PATH, "utf8");
  console.log(`Applying ${path.relative(process.cwd(), SEED_PATH)}…`);
  await pool.query(sql);
  console.log("Rewardz protocol + wallet-connect campaign seed applied.");
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("seed-rewardz failed:", err);
    await pool.end();
    process.exit(1);
  });
