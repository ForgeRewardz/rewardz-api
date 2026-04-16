// Per-protocol issuance-capacity debit + warning emission.
//
// Called from inside the `awardPoints` transaction so the capacity guard, the
// point_events insert, and the protocol_events emit all share one atomic unit
// of work (READ COMMITTED).
//
// Thresholds are sourced from `league.capacity_warning_thresholds` (devnet:
// [0.25, 0.1, 0.0]). The denominator for the percentage is computed per
// protocol (task 16a):
//
//   - `active_stake > 0`  → baseline = issuance_ratio × active_stake
//                           (stake-to-unlock flow, keeper's stake_watcher
//                           mirrors the on-chain ProtocolStake PDA into
//                           protocols.active_stake)
//   - otherwise           → baseline = starter_grant_rewardz
//                           (legacy / pre-stake path — unchanged from before
//                           16a so existing capacity tests continue to assert
//                           against the devnet 100-unit grant).

import type { PoolClient } from "pg";
import { league } from "../config.js";

export class CapacityExhaustedError extends Error {
  constructor(
    public readonly protocolId: string,
    public readonly requested: bigint,
  ) {
    super(
      `capacity exhausted for protocol ${protocolId} (requested ${requested})`,
    );
    this.name = "CapacityExhaustedError";
  }
}

export interface CapacityThresholdCrossing {
  level: "warning" | "critical";
  pct: number;
  remaining: bigint;
}

/**
 * Compute the per-protocol capacity baseline.
 *
 * Exported so callers that surface the baseline (e.g. /league/status for
 * the console capacity banner) stay in lockstep with the value the
 * threshold-crossing detector uses. Diverging baselines would mean the
 * UI shows "50% remaining" while ops receives a "warning: 25% crossed"
 * alert — exactly the silent drift we burned on the ranking constants
 * prior to task 24's cleanup.
 */
export function capacityBaseline(activeStake: bigint | null): bigint {
  if (activeStake !== null && activeStake > 0n) {
    return BigInt(league.issuance_ratio) * activeStake;
  }
  return BigInt(league.starter_grant_rewardz);
}

/**
 * Atomically subtract `amount` from `protocols.remaining_capacity`.
 *
 * Fails with CapacityExhaustedError when the guard matches zero rows — either
 * because remaining < amount OR remaining is NULL (not yet initialised). The
 * caller distinguishes via a pre-SELECT if the UX needs to differentiate.
 *
 * Returns the post-debit remaining and any threshold crossing detected against
 * the per-protocol baseline (task 16a) so the caller can emit a
 * protocol_events row.
 */
export async function debitCapacity(
  client: PoolClient,
  protocolId: string,
  amount: bigint,
): Promise<{ remaining: bigint; crossed: CapacityThresholdCrossing | null }> {
  // RETURNING pulls active_stake alongside the post-debit balance so the
  // baseline derivation happens on the exact row the UPDATE just mutated
  // — no second SELECT race.
  const res = await client.query<{
    remaining_capacity: string;
    prev_remaining: string;
    active_stake: string | null;
  }>(
    `UPDATE protocols
        SET remaining_capacity = remaining_capacity - $2::bigint
      WHERE id = $1
        AND remaining_capacity IS NOT NULL
        AND remaining_capacity >= $2::bigint
      RETURNING remaining_capacity,
                (remaining_capacity + $2::bigint)::text AS prev_remaining,
                active_stake::text AS active_stake`,
    [protocolId, amount.toString()],
  );

  if (res.rowCount === 0) {
    throw new CapacityExhaustedError(protocolId, amount);
  }

  const remaining = BigInt(res.rows[0].remaining_capacity);
  const prev = BigInt(res.rows[0].prev_remaining);
  const activeStake =
    res.rows[0].active_stake == null ? null : BigInt(res.rows[0].active_stake);
  const baseline = capacityBaseline(activeStake);
  const crossed = detectThresholdCrossing(prev, remaining, baseline);
  return { remaining, crossed };
}

// Fixed-point scale for converting the decimal pct (0.0..1.0) into an
// integer multiplier so threshold math stays in BigInt. 1e6 gives 6
// decimal places of pct precision — far more than the [0.25, 0.1, 0.0]
// config needs, and well inside Number.MAX_SAFE_INTEGER for the
// `Math.round(pct * SCALE)` step so the Number→BigInt hop is exact.
//
// Why BigInt instead of Number? baseline = issuance_ratio × active_stake.
// With 9-decimal SPL tokens and large protocol stakes, the product can
// exceed 2^53 (Number.MAX_SAFE_INTEGER). Above that, Number quantises to
// the nearest representable double and threshold boundaries drift by up
// to ~1024 units per 2^63 of magnitude — meaning the same debit can
// emit a critical one tick and miss it the next. BigInt math is exact
// across the full u64 stake range.
const PCT_SCALE = 1_000_000n;

function detectThresholdCrossing(
  prev: bigint,
  post: bigint,
  baseline: bigint,
): CapacityThresholdCrossing | null {
  if (baseline <= 0n) return null;

  // Walk every threshold and pick the MOST SEVERE crossing (lowest pct).
  // A single debit that straddles multiple bounds (e.g. 40 → 0 across
  // [0.25, 0.1, 0.0]) must surface as critical, not warning — otherwise
  // ops loses the "capacity fully drained" alert exactly when it matters.
  let mostSevere: CapacityThresholdCrossing | null = null;
  for (const pct of league.capacity_warning_thresholds) {
    const scaledPct = BigInt(Math.round(pct * Number(PCT_SCALE)));
    // Ceiling division: (baseline * pct) rounded up to the next integer
    // so a debit landing exactly ON the boundary counts as crossing.
    // Matches the original `Math.ceil` semantic — conservative, prefer a
    // spurious warning over a missed critical.
    const numerator = baseline * scaledPct;
    const bound =
      numerator === 0n ? 0n : (numerator + PCT_SCALE - 1n) / PCT_SCALE;
    if (prev > bound && post <= bound) {
      if (mostSevere === null || pct < mostSevere.pct) {
        mostSevere = {
          level: pct === 0 ? "critical" : "warning",
          pct,
          remaining: post,
        };
      }
    }
  }
  return mostSevere;
}

export async function emitCapacityEvent(
  client: PoolClient,
  protocolId: string,
  crossing: CapacityThresholdCrossing,
): Promise<void> {
  await client.query(
    `INSERT INTO protocol_events (protocol_id, kind, level, payload)
     VALUES ($1, 'capacity_warning', $2, $3::jsonb)`,
    [
      protocolId,
      crossing.level,
      JSON.stringify({
        threshold_pct: crossing.pct,
        remaining: crossing.remaining.toString(),
      }),
    ],
  );
}
