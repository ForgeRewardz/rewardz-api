import { query } from "../db/client.js";
import { config } from "../config.js";

export interface DiscoveryQuotaState {
  wallet: string;
  dayUtc: string;
  used: number;
  remaining: number;
  resetAtUtc: string;
}

function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextUtcMidnightIso(): string {
  // The (wallet, day_utc) PK is the authoritative reset boundary: a new UTC
  // day produces a new row with used=0 automatically, so this value is purely
  // a client-facing hint and never gates any server-side reset logic.
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
  return next.toISOString();
}

function buildState(
  wallet: string,
  used: number,
  day: string,
): DiscoveryQuotaState {
  const limit = config.DISCOVERY_FREE_QUOTA_PER_DAY;
  return {
    wallet,
    dayUtc: day,
    used,
    remaining: Math.max(0, limit - used),
    resetAtUtc: nextUtcMidnightIso(),
  };
}

export async function readQuota(wallet: string): Promise<DiscoveryQuotaState> {
  const day = currentUtcDay();
  const result = await query<{ used: number }>(
    `SELECT used FROM discovery_usage WHERE wallet = $1 AND day_utc = $2`,
    [wallet, day],
  );
  const used = result.rows[0]?.used ?? 0;
  return buildState(wallet, used, day);
}

export async function consumeQuota(
  wallet: string,
): Promise<DiscoveryQuotaState & { consumed: boolean }> {
  const day = currentUtcDay();
  const limit = config.DISCOVERY_FREE_QUOTA_PER_DAY;

  // Single atomic statement: INSERT the row if it doesn't exist, otherwise
  // UPDATE-increment iff the predicate (used < limit) holds. When the predicate
  // fails, ON CONFLICT DO UPDATE becomes a no-op and RETURNING yields zero
  // rows — we detect that via the CTE and fall through to a plain SELECT of
  // the current value in the same round-trip. This is race-safe even on a
  // brand-new (wallet, day) pair because the INSERT itself is serialised by
  // the PK and the conflict path is handled atomically by Postgres.
  const result = await query<{ used: number; consumed: boolean }>(
    `WITH upsert AS (
       INSERT INTO discovery_usage (wallet, day_utc, used)
       VALUES ($1, $2, 1)
       ON CONFLICT (wallet, day_utc) DO UPDATE
         SET used = discovery_usage.used + 1
         WHERE discovery_usage.used < $3
       RETURNING used
     )
     SELECT
       COALESCE(
         (SELECT used FROM upsert),
         (SELECT used FROM discovery_usage WHERE wallet = $1 AND day_utc = $2)
       ) AS used,
       EXISTS (SELECT 1 FROM upsert) AS consumed`,
    [wallet, day, limit],
  );

  const row = result.rows[0];
  const used = row?.used ?? 0;
  const consumed = row?.consumed ?? false;
  return { ...buildState(wallet, used, day), consumed };
}
