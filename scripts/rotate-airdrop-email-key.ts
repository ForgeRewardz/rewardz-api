/**
 * rotate-airdrop-email-key.ts
 *
 * One-shot operator script: re-encrypts every row in `airdrop_signups`
 * from an OLD pgcrypto symmetric key to a NEW one. Back-stops risk R6
 * in the plan — `AIRDROP_EMAIL_KEY` is env-only, so if it leaks we
 * need a way to rotate without losing the signup list.
 *
 * Usage:
 *   AIRDROP_EMAIL_KEY_OLD=xxx \
 *   AIRDROP_EMAIL_KEY_NEW=yyy \
 *   DATABASE_URL=postgres://... \
 *   pnpm tsx api/scripts/rotate-airdrop-email-key.ts [--dry-run]
 *
 * Notes:
 *   - Runs inside a single transaction. Either every row migrates
 *     to the new key, or nothing changes.
 *   - The row-by-row decrypt-then-encrypt is done in SQL so no
 *     plaintext ever leaves Postgres. An email that can't be
 *     decrypted with the old key fails the whole transaction —
 *     intentional, because silently dropping rows would be worse
 *     than a loud abort.
 *   - After a successful run, update `AIRDROP_EMAIL_KEY` in the
 *     runtime env to the NEW value and restart the api. The old
 *     key can then be destroyed.
 *
 * This file is a scaffold — it is wired end-to-end but not yet
 * covered by integration tests. See followups.md.
 */

import "dotenv/config";
import { Pool } from "pg";

interface Args {
  oldKey: string;
  newKey: string;
  databaseUrl: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const oldKey = process.env.AIRDROP_EMAIL_KEY_OLD;
  const newKey = process.env.AIRDROP_EMAIL_KEY_NEW;
  const databaseUrl = process.env.DATABASE_URL;
  const dryRun = process.argv.includes("--dry-run");

  const missing: string[] = [];
  if (!oldKey) missing.push("AIRDROP_EMAIL_KEY_OLD");
  if (!newKey) missing.push("AIRDROP_EMAIL_KEY_NEW");
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (missing.length > 0) {
    console.error(
      `Missing required env vars: ${missing.join(", ")}. ` +
        "See rotate-airdrop-email-key.ts header for usage.",
    );
    process.exit(1);
  }
  if (oldKey === newKey) {
    console.error("OLD and NEW keys are identical — nothing to rotate.");
    process.exit(1);
  }
  // `as string` safe after the missing-check gate above.
  return {
    oldKey: oldKey as string,
    newKey: newKey as string,
    databaseUrl: databaseUrl as string,
    dryRun,
  };
}

async function main(): Promise<void> {
  const { oldKey, newKey, databaseUrl, dryRun } = parseArgs();

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Count rows for a visible before/after — cheap, and it's nice
    // for the operator to see the scope before the UPDATE runs.
    const countRes = await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM airdrop_signups",
    );
    const total = Number(countRes.rows[0]?.n ?? 0);
    console.log(`airdrop_signups: ${total} row(s) to re-encrypt`);

    if (total === 0) {
      await client.query("COMMIT");
      console.log("No rows — nothing to do.");
      return;
    }

    // Row-by-row re-encrypt. Doing this in one UPDATE statement
    // keeps every plaintext inside Postgres — pgp_sym_decrypt
    // returns the plaintext as a pg internal value and
    // pgp_sym_encrypt immediately re-wraps it under the new key,
    // all before the row is written back. If any row fails to
    // decrypt (wrong OLD key, corrupt row), the statement errors
    // and the outer BEGIN/ROLLBACK reverts the rest.
    const updateRes = await client.query(
      `UPDATE airdrop_signups
          SET email_encrypted =
              pgp_sym_encrypt(
                  pgp_sym_decrypt(email_encrypted, $1),
                  $2
              )`,
      [oldKey, newKey],
    );
    console.log(`Re-encrypted ${updateRes.rowCount ?? 0} row(s).`);

    if (dryRun) {
      await client.query("ROLLBACK");
      console.log("--dry-run: rolled back. No changes committed.");
      return;
    }

    await client.query("COMMIT");
    console.log("Committed. Update AIRDROP_EMAIL_KEY and restart the api.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* rollback best-effort; the original error is what matters */
    });
    // Log only { code, message } so pg error envelopes (which can
    // include `internalQuery` / `where` / `detail` fragments) do not
    // land in operator scrollback. Bind parameters never appear in
    // the UPDATE's SQL text — they're sent as separate wire values —
    // but the pg error object itself is still worth trimming.
    const trimmed = {
      code: (err as { code?: unknown })?.code,
      message: err instanceof Error ? err.message : String(err),
    };
    console.error("Rotation failed — rolled back:", trimmed);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Unexpected failure:", err);
  process.exit(1);
});
