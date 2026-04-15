import { PublicKey } from "@solana/web3.js";
import { GameRoundStatus, MiningResultKind } from "@rewardz/types";
import { query } from "../db/client.js";
import { keccak256 } from "./keccak256.js";

// Re-export shared enums so existing consumers importing from this module
// don't break. Canonical definitions live in @rewardz/types.
export { GameRoundStatus, MiningResultKind };

// JSON-wire shapes for API responses. These are serialisations of the
// canonical `GameRoundSummary` / `PlayerDeploymentStatus` in @rewardz/types:
// bigints serialise to decimal strings, Dates to ISO-8601 strings. Field
// names and optionality must match the canonical interfaces exactly.
export interface GameRoundSummary {
  roundId: string;
  status: GameRoundStatus;
  startSlot: string;
  endSlot: string;
  estimatedEndsAt: string | null;
  playerCount: number;
  gameFeeLamports: string;
  hitRateBps: number;
  tokensPerRound: string;
  motherlodePool: string;
  motherlodeMinThreshold: string;
  motherlodeProbabilityBps: number;
  settleTimestamp: string | null;
  expiresAt: string | null;
  refundMode: boolean;
}

export interface PlayerDeploymentStatus {
  walletAddress: string;
  roundId: string;
  pointsDeployed: string | null;
  feePaid: string | null;
  deployedAt: string | null;
  result: MiningResultKind;
  settled: boolean;
  isHit: boolean | null;
  rewardAmount: string;
  motherlodeShare: string;
  claimed: boolean;
  checkpointed: boolean;
  checkpointFee: string | null;
}

export interface GameRoundResults {
  round: GameRoundSummary;
  hitCount: number;
  totalHitPoints: string;
  tokensMinted: string;
  motherlodeTriggered: boolean;
  motherlodeAmount: string;
  player: PlayerDeploymentStatus | null;
}

interface GameRoundRow {
  round_id: string;
  start_slot: string;
  end_slot: string;
  status: GameRoundStatus;
  player_count: number;
  game_fee_lamports: string;
  hit_rate_bps: number;
  tokens_per_round: string;
  motherlode_pool: string;
  motherlode_min_threshold: string;
  motherlode_probability_bps: number;
  hit_count: number;
  total_hit_points: string;
  tokens_minted: string;
  motherlode_triggered: boolean;
  motherlode_amount: string;
  created_at: Date;
  settle_timestamp: string | null;
  expires_at: string | null;
  refund_mode: boolean;
}

interface PlayerDeploymentRow {
  wallet_address: string;
  round_id: string;
  points_deployed: string | null;
  fee_paid: string | null;
  deployed_at: Date | null;
  is_hit: boolean | null;
  reward_amount: string;
  motherlode_share: string;
  claimed: boolean;
  settled: boolean;
  checkpointed: boolean;
}

function estimatedEndsAt(row: GameRoundRow): string | null {
  if (row.status !== "active" && row.status !== "settling") return null;
  const slotDelta = Number(BigInt(row.end_slot) - BigInt(row.start_slot));
  if (!Number.isFinite(slotDelta) || slotDelta <= 0) return null;
  return new Date(row.created_at.getTime() + slotDelta * 400).toISOString();
}

function unixSecondsToIso(value: string | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

function serialiseRound(row: GameRoundRow): GameRoundSummary {
  return {
    roundId: row.round_id,
    status: row.status,
    startSlot: row.start_slot,
    endSlot: row.end_slot,
    estimatedEndsAt: estimatedEndsAt(row),
    playerCount: row.player_count,
    gameFeeLamports: row.game_fee_lamports,
    hitRateBps: row.hit_rate_bps,
    tokensPerRound: row.tokens_per_round,
    motherlodePool: row.motherlode_pool,
    motherlodeMinThreshold: row.motherlode_min_threshold,
    motherlodeProbabilityBps: row.motherlode_probability_bps,
    settleTimestamp: unixSecondsToIso(row.settle_timestamp),
    expiresAt: unixSecondsToIso(row.expires_at),
    refundMode: row.refund_mode,
  };
}

function resultKind(row: PlayerDeploymentRow): MiningResultKind {
  if (!row.settled) return MiningResultKind.Pending;
  if (row.is_hit === true) return MiningResultKind.Hit;
  if (row.is_hit === false) return MiningResultKind.Miss;
  return MiningResultKind.Skipped;
}

function serialisePlayer(row: PlayerDeploymentRow): PlayerDeploymentStatus {
  return {
    walletAddress: row.wallet_address,
    roundId: row.round_id,
    pointsDeployed: row.points_deployed,
    feePaid: row.fee_paid,
    deployedAt: row.deployed_at?.toISOString() ?? null,
    result: resultKind(row),
    settled: row.settled,
    isHit: row.is_hit,
    rewardAmount: row.reward_amount,
    motherlodeShare: row.motherlode_share,
    claimed: row.claimed,
    checkpointed: row.checkpointed,
    // checkpointFee is not yet persisted in the DB — surfaced as null
    // until a migration adds `checkpoint_fee` to player_deployments.
    checkpointFee: null,
  };
}

async function getPlayerDeployment(
  roundId: string,
  walletAddress?: string,
): Promise<PlayerDeploymentStatus | null> {
  if (!walletAddress) return null;
  const result = await query<PlayerDeploymentRow>(
    `SELECT wallet_address, round_id::text, points_deployed::text,
            fee_paid::text, deployed_at, is_hit, reward_amount::text,
            motherlode_share::text, claimed, settled, checkpointed
       FROM player_deployments
      WHERE round_id = $1 AND wallet_address = $2
      LIMIT 1`,
    [roundId, walletAddress],
  );
  return result.rows[0] ? serialisePlayer(result.rows[0]) : null;
}

export async function getCurrentRound(walletAddress?: string): Promise<{
  round: GameRoundSummary | null;
  player: PlayerDeploymentStatus | null;
}> {
  const result = await query<GameRoundRow>(
    `SELECT round_id::text, start_slot::text, end_slot::text, status,
            player_count, game_fee_lamports::text, hit_rate_bps,
            tokens_per_round::text, motherlode_pool::text,
            motherlode_min_threshold::text, motherlode_probability_bps,
            hit_count, total_hit_points::text, tokens_minted::text,
            motherlode_triggered, motherlode_amount::text, created_at,
            settle_timestamp::text, expires_at::text, refund_mode
       FROM game_rounds
      WHERE status IN ('waiting', 'active', 'settling')
      ORDER BY round_id DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return { round: null, player: null };
  return {
    round: serialiseRound(row),
    player: await getPlayerDeployment(row.round_id, walletAddress),
  };
}

export async function getRoundStatus(
  roundId: string,
  walletAddress?: string,
): Promise<{
  round: GameRoundSummary;
  player: PlayerDeploymentStatus | null;
} | null> {
  const result = await query<GameRoundRow>(
    `SELECT round_id::text, start_slot::text, end_slot::text, status,
            player_count, game_fee_lamports::text, hit_rate_bps,
            tokens_per_round::text, motherlode_pool::text,
            motherlode_min_threshold::text, motherlode_probability_bps,
            hit_count, total_hit_points::text, tokens_minted::text,
            motherlode_triggered, motherlode_amount::text, created_at,
            settle_timestamp::text, expires_at::text, refund_mode
       FROM game_rounds
      WHERE round_id = $1
      LIMIT 1`,
    [roundId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    round: serialiseRound(row),
    player: await getPlayerDeployment(row.round_id, walletAddress),
  };
}

export async function getRoundPlayers(
  roundId: string,
  walletAddress?: string,
): Promise<{
  roundId: string;
  playerCount: number;
  player: PlayerDeploymentStatus | null;
} | null> {
  const status = await getRoundStatus(roundId, walletAddress);
  if (!status) return null;
  return {
    roundId: status.round.roundId,
    playerCount: status.round.playerCount,
    player: status.player,
  };
}

export async function getRoundResults(
  roundId: string,
  walletAddress?: string,
): Promise<GameRoundResults | null> {
  const result = await query<GameRoundRow>(
    `SELECT round_id::text, start_slot::text, end_slot::text, status,
            player_count, game_fee_lamports::text, hit_rate_bps,
            tokens_per_round::text, motherlode_pool::text,
            motherlode_min_threshold::text, motherlode_probability_bps,
            hit_count, total_hit_points::text, tokens_minted::text,
            motherlode_triggered, motherlode_amount::text, created_at,
            settle_timestamp::text, expires_at::text, refund_mode
       FROM game_rounds
      WHERE round_id = $1
      LIMIT 1`,
    [roundId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    round: serialiseRound(row),
    hitCount: row.hit_count,
    totalHitPoints: row.total_hit_points,
    tokensMinted: row.tokens_minted,
    motherlodeTriggered: row.motherlode_triggered,
    motherlodeAmount: row.motherlode_amount,
    player: await getPlayerDeployment(row.round_id, walletAddress),
  };
}

export async function getRoundHistory(
  limit: number,
  offset: number,
): Promise<{ entries: GameRoundSummary[]; total: number }> {
  const [entries, total] = await Promise.all([
    query<GameRoundRow>(
      `SELECT round_id::text, start_slot::text, end_slot::text, status,
              player_count, game_fee_lamports::text, hit_rate_bps,
              tokens_per_round::text, motherlode_pool::text,
              motherlode_min_threshold::text, motherlode_probability_bps,
              hit_count, total_hit_points::text, tokens_minted::text,
              motherlode_triggered, motherlode_amount::text, created_at,
            settle_timestamp::text, expires_at::text, refund_mode
         FROM game_rounds
        ORDER BY round_id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    query<{ count: string }>("SELECT COUNT(*)::text AS count FROM game_rounds"),
  ]);
  return {
    entries: entries.rows.map(serialiseRound),
    total: Number(total.rows[0]?.count ?? "0"),
  };
}

// ── Event shapes ────────────────────────────────────────────
//
// The F4 three-step settlement refactor changed what the on-chain program
// emits. Per-player hit/reward is no longer computed inside `settle_round`
// — it is deferred to `checkpoint_round`, which emits `CheckpointRecorded`.
// `RoundSettled` now carries only the snapshot fields needed to re-derive
// outcomes off-chain (settle_timestamp, expires_at, refund_mode,
// total_points_deployed).
export type ParsedGameEvent =
  | {
      eventName: "RoundStarted";
      roundId: string;
      startSlot: string;
      endSlot: string;
    }
  | {
      eventName: "PlayerDeployed";
      roundId: string;
      walletAddress: string;
      pointsDeployed: string;
    }
  | {
      eventName: "RoundSettled";
      roundId: string;
      settleTimestamp: string;
      expiresAt: string;
      refundMode: boolean;
      totalPointsDeployed: string;
    }
  | {
      eventName: "CheckpointRecorded";
      roundId: string;
      walletAddress: string;
      rewardAmount: string;
      isHit: boolean;
    }
  | {
      eventName: "MotherlodeTriggered";
      roundId: string;
      motherlodeAmount: string;
    }
  | {
      eventName: "RewardClaimed";
      roundId: string;
      walletAddress: string;
      amount: string;
    };

function readU64(payload: Buffer, offset: number): string {
  if (payload.length < offset + 8) {
    throw new Error(`payload too short for u64 at offset ${offset}`);
  }
  return payload.readBigUInt64LE(offset).toString();
}

function readI64(payload: Buffer, offset: number): string {
  if (payload.length < offset + 8) {
    throw new Error(`payload too short for i64 at offset ${offset}`);
  }
  return payload.readBigInt64LE(offset).toString();
}

function readPubkey(payload: Buffer, offset: number): string {
  if (payload.length < offset + 32) {
    throw new Error(`payload too short for pubkey at offset ${offset}`);
  }
  return new PublicKey(payload.subarray(offset, offset + 32)).toBase58();
}

export function parseGameProgramLog(message: string): ParsedGameEvent | null {
  if (!message.startsWith("Program data:")) return null;
  const parts = message.slice("Program data:".length).trim().split(/\s+/);
  if (parts.length < 2) return null;

  let eventName: string;
  let payload: Buffer;
  try {
    eventName = Buffer.from(parts[0], "base64").toString("utf8");
    payload = Buffer.from(parts[1], "base64");
  } catch {
    return null;
  }

  switch (eventName) {
    case "RoundStarted":
      return {
        eventName,
        roundId: readU64(payload, 0),
        startSlot: readU64(payload, 8),
        endSlot: readU64(payload, 16),
      };
    case "PlayerDeployed":
      return {
        eventName,
        roundId: readU64(payload, 0),
        walletAddress: readPubkey(payload, 8),
        pointsDeployed: readU64(payload, 40),
      };
    case "RoundSettled":
      // Post-F3 payload (33 bytes): round_id (8) | settle_timestamp i64 (8)
      // | expires_at u64 (8) | refund_mode u8 (1) | total_points_deployed u64 (8)
      return {
        eventName,
        roundId: readU64(payload, 0),
        settleTimestamp: readI64(payload, 8),
        expiresAt: readU64(payload, 16),
        refundMode: payload[24] === 1,
        totalPointsDeployed: readU64(payload, 25),
      };
    case "CheckpointRecorded":
      // Post-F3 payload (49 bytes): round_id (8) | authority pubkey (32)
      // | rewards_amount u64 (8) | hit u8 (1)
      return {
        eventName,
        roundId: readU64(payload, 0),
        walletAddress: readPubkey(payload, 8),
        rewardAmount: readU64(payload, 40),
        isHit: payload[48] === 1,
      };
    case "MotherlodeTriggered":
      // Post-F3 payload (16 bytes): round_id (8) | motherlode_amount u64 (8)
      return {
        eventName,
        roundId: readU64(payload, 0),
        motherlodeAmount: readU64(payload, 8),
      };
    case "RewardClaimed":
      return {
        eventName,
        roundId: readU64(payload, 0),
        walletAddress: readPubkey(payload, 8),
        amount: readU64(payload, 40),
      };
    default:
      return null;
  }
}

// ── Deterministic synthesis — mirrors program/src/game_round.rs ───────
//
// On-chain PRNG lives in `compute_player_hit` / `compute_motherlode_hit`.
// Off-chain synthesis computes the same predicates so the API can populate
// is_hit / reward_amount rows before `CheckpointRecorded` events arrive
// (e.g. when the cranker batches are slow). Reconciliation from
// `CheckpointRecorded` overwrites with the authoritative on-chain values.
//
// Byte-for-byte layout (Keccak-256 of the concatenation):
//   slot_hash (32) || round_id LE (8) || settle_timestamp LE (8) || authority (32)
// The first 8 bytes of the digest are interpreted as a little-endian u64
// and taken mod 10_000; hit iff that value < hit_rate_bps.

function leU64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt.asUintN(64, n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function leI64(n: bigint): Uint8Array {
  // Rust writes `i64::to_le_bytes` as two's-complement LE. Mask to 64-bit.
  return leU64(BigInt.asUintN(64, n));
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function firstU64LE(digest: Uint8Array): bigint {
  if (digest.length < 8) throw new Error("digest < 8 bytes");
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(digest[i]);
  return v;
}

function pubkeyBytes(walletAddress: string): Uint8Array {
  return new PublicKey(walletAddress).toBytes();
}

function hashBytes(slotHash: Uint8Array): Uint8Array {
  if (slotHash.length !== 32) {
    throw new Error(`slot_hash must be 32 bytes, got ${slotHash.length}`);
  }
  return slotHash;
}

/**
 * TS port of `compute_player_hit` (program/src/game_round.rs).
 *
 * @param slotHash          32-byte slot hash snapshotted at settle time
 * @param roundId           u64 round id
 * @param settleTimestamp   i64 unix seconds recorded in settle_round
 * @param walletAddress     Base58 pubkey of the deployment authority
 * @param hitRateBps        hit rate in basis points (0..=10_000)
 */
export function computePlayerHit(args: {
  slotHash: Uint8Array;
  roundId: bigint;
  settleTimestamp: bigint;
  walletAddress: string;
  hitRateBps: number;
}): boolean {
  const preimage = concatBytes(
    hashBytes(args.slotHash),
    leU64(args.roundId),
    leI64(args.settleTimestamp),
    pubkeyBytes(args.walletAddress),
  );
  const digest = keccak256(preimage);
  const value = firstU64LE(digest);
  return value % 10_000n < BigInt(args.hitRateBps);
}

/**
 * TS port of `compute_motherlode_hit` (program/src/game_round.rs).
 */
export function computeMotherlodeHit(args: {
  slotHash: Uint8Array;
  roundId: bigint;
  probabilityBps: number;
}): boolean {
  const preimage = concatBytes(
    hashBytes(args.slotHash),
    leU64(args.roundId),
    new TextEncoder().encode("motherlode"),
  );
  const digest = keccak256(preimage);
  const value = firstU64LE(digest);
  return value % 10_000n < BigInt(args.probabilityBps);
}

/**
 * TS port of the reward-amount clamp + pro-rata in `process_checkpoint_round`:
 *
 *   expected_hit_points = max(total_points * hit_rate_bps / 10_000,
 *                             points_deployed)
 *   reward_amount = is_hit && expected_hit_points > 0
 *     ? tokens_minted * points_deployed / expected_hit_points
 *     : 0
 *
 * All arithmetic uses BigInt to match u64 semantics; division truncates to
 * match Rust's `/` on unsigned integers.
 */
export function computeRewardAmount(args: {
  isHit: boolean;
  pointsDeployed: bigint;
  totalPointsDeployed: bigint;
  hitRateBps: number;
  tokensMinted: bigint;
}): bigint {
  if (!args.isHit) return 0n;
  const proportional =
    (args.totalPointsDeployed * BigInt(args.hitRateBps)) / 10_000n;
  const expected =
    proportional >= args.pointsDeployed ? proportional : args.pointsDeployed;
  if (expected === 0n) return 0n;
  return (args.tokensMinted * args.pointsDeployed) / expected;
}

/**
 * TS port of the per-player motherlode-share pro-rata from the pre-F3
 * `process_settle_round` (see
 * mvp-smart-contracts@f620107:program/src/game_round.rs, the motherlode
 * distribution block around the settle loop):
 *
 *   motherlode_share = is_hit && motherlode_triggered
 *       ? motherlode_amount * points_deployed / total_hit_points
 *       : 0
 *
 * Post-F3 the on-chain program collapses motherlode rounds into
 * `refund_mode` (no mint, no per-player share), so in the current program
 * this function returns 0 in practice. We still port it byte-for-byte for
 * parity with the reference formula and so analytics / legacy surfaces can
 * compute a hypothetical share amount from stored event data. Division
 * truncates to match Rust u64 semantics; a zero denominator returns 0.
 */
export function computeMotherlodeShare(args: {
  isHit: boolean;
  motherlodeTriggered: boolean;
  motherlodeAmount: bigint;
  pointsDeployed: bigint;
  totalHitPoints: bigint;
}): bigint {
  if (!(args.isHit && args.motherlodeTriggered)) return 0n;
  if (args.totalHitPoints === 0n) return 0n;
  return (args.motherlodeAmount * args.pointsDeployed) / args.totalHitPoints;
}

/**
 * Convenience: given the snapshot from a `RoundSettled` event plus a single
 * player's deployment, derive the same (is_hit, reward_amount,
 * motherlode_share) triple that `checkpoint_round` (and the legacy
 * motherlode distribution) would emit. The API uses this to populate rows
 * ahead of checkpoint events; `CheckpointRecorded` reconciliation
 * overwrites `is_hit` / `reward_amount` with authoritative on-chain values.
 *
 * `refundMode` short-circuits to zero rewards regardless of points — the
 * on-chain claim path refunds the fee instead. Callers that don't yet
 * track motherlode outcomes can omit the `motherlode*` fields — the
 * synthesiser treats them as !triggered and returns share = 0.
 *
 * NOTE: synthesis is best-effort until F6 lands the authoritative cranker.
 * Callers must pass the `slot_hash` snapshotted at settle time; the
 * `RoundSettled` event payload does NOT carry it (see
 * src/services/game-event-listener.ts — RoundSettled handler). Until the
 * keeper pipes slot_hash into the API (or the listener adds an RPC
 * getAccountInfo fallback), rounds where slot_hash is NULL simply skip
 * synthesis; `CheckpointRecorded` remains the source of truth.
 */
export function synthesizePlayerOutcome(args: {
  slotHash: Uint8Array;
  roundId: bigint;
  settleTimestamp: bigint;
  walletAddress: string;
  hitRateBps: number;
  pointsDeployed: bigint;
  totalPointsDeployed: bigint;
  tokensMinted: bigint;
  refundMode: boolean;
  motherlodeTriggered?: boolean;
  motherlodeAmount?: bigint;
  totalHitPoints?: bigint;
}): { isHit: boolean; rewardAmount: bigint; motherlodeShare: bigint } {
  if (args.refundMode) {
    return { isHit: false, rewardAmount: 0n, motherlodeShare: 0n };
  }
  const isHit = computePlayerHit({
    slotHash: args.slotHash,
    roundId: args.roundId,
    settleTimestamp: args.settleTimestamp,
    walletAddress: args.walletAddress,
    hitRateBps: args.hitRateBps,
  });
  const rewardAmount = computeRewardAmount({
    isHit,
    pointsDeployed: args.pointsDeployed,
    totalPointsDeployed: args.totalPointsDeployed,
    hitRateBps: args.hitRateBps,
    tokensMinted: args.tokensMinted,
  });
  const motherlodeShare = computeMotherlodeShare({
    isHit,
    motherlodeTriggered: args.motherlodeTriggered ?? false,
    motherlodeAmount: args.motherlodeAmount ?? 0n,
    pointsDeployed: args.pointsDeployed,
    totalHitPoints: args.totalHitPoints ?? 0n,
  });
  return { isHit, rewardAmount, motherlodeShare };
}

export async function recordGameEvent(
  event: ParsedGameEvent,
  signature?: string,
): Promise<void> {
  const walletAddress = "walletAddress" in event ? event.walletAddress : null;
  await query(
    `INSERT INTO game_events (
       event_name, round_id, wallet_address, signature, payload_jsonb
     )
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      event.eventName,
      event.roundId,
      walletAddress,
      signature ?? null,
      JSON.stringify(event),
    ],
  );
}

interface RoundSynthesisRow {
  slot_hash: Buffer | null;
  hit_rate_bps: number;
  tokens_minted: string;
  motherlode_triggered: boolean;
  motherlode_amount: string;
  total_hit_points: string;
}

interface DeploymentSynthesisRow {
  wallet_address: string;
  points_deployed: string | null;
  settled: boolean;
}

/**
 * Best-effort per-player synthesis invoked from the `RoundSettled` branch
 * of `applyGameEvent`. Reads the round snapshot, iterates every
 * PlayerDeployment that has not yet been authoritatively settled by a
 * CheckpointRecorded event, and upserts (is_hit, reward_amount,
 * motherlode_share) computed by `synthesizePlayerOutcome`.
 *
 * No-op when:
 *   • refund_mode is true (on-chain claim path is the refund flow)
 *   • game_rounds.slot_hash is NULL (no-one has published the snapshot
 *     yet — stay silent, let CheckpointRecorded handle it)
 */
async function synthesiseRoundOutcomes(event: {
  roundId: string;
  settleTimestamp: string;
  refundMode: boolean;
  totalPointsDeployed: string;
}): Promise<void> {
  if (event.refundMode) return;

  const roundRes = await query<RoundSynthesisRow>(
    `SELECT slot_hash, hit_rate_bps,
            tokens_minted::text, motherlode_triggered,
            motherlode_amount::text, total_hit_points::text
       FROM game_rounds
      WHERE round_id = $1
      LIMIT 1`,
    [event.roundId],
  );
  const round = roundRes.rows[0];
  if (!round?.slot_hash) return;
  const slotHash = new Uint8Array(round.slot_hash);
  if (slotHash.length !== 32) return;

  const playersRes = await query<DeploymentSynthesisRow>(
    `SELECT wallet_address, points_deployed::text, settled
       FROM player_deployments
      WHERE round_id = $1`,
    [event.roundId],
  );
  const totalPoints = BigInt(event.totalPointsDeployed);
  const tokensMinted = BigInt(round.tokens_minted);
  const motherlodeAmount = BigInt(round.motherlode_amount);
  const totalHitPoints = BigInt(round.total_hit_points);
  const roundIdBig = BigInt(event.roundId);
  const settleTsBig = BigInt(event.settleTimestamp);

  for (const p of playersRes.rows) {
    // Skip players already settled by CheckpointRecorded — that branch is
    // authoritative. Synthesis only fills rows ahead of the cranker.
    if (p.settled) continue;
    if (!p.points_deployed) continue;
    const outcome = synthesizePlayerOutcome({
      slotHash,
      roundId: roundIdBig,
      settleTimestamp: settleTsBig,
      walletAddress: p.wallet_address,
      hitRateBps: round.hit_rate_bps,
      pointsDeployed: BigInt(p.points_deployed),
      totalPointsDeployed: totalPoints,
      tokensMinted,
      refundMode: false,
      motherlodeTriggered: round.motherlode_triggered,
      motherlodeAmount,
      totalHitPoints,
    });
    // Best-effort: only touch rows still settled=false so we never stomp
    // on a CheckpointRecorded write that raced ahead.
    await query(
      `UPDATE player_deployments
          SET is_hit = $3,
              reward_amount = $4,
              motherlode_share = $5,
              updated_at = NOW()
        WHERE round_id = $1 AND wallet_address = $2 AND settled = false`,
      [
        event.roundId,
        p.wallet_address,
        outcome.isHit,
        outcome.rewardAmount.toString(),
        outcome.motherlodeShare.toString(),
      ],
    );
  }
}

export async function applyGameEvent(
  event: ParsedGameEvent,
  signature?: string,
): Promise<void> {
  await recordGameEvent(event, signature);

  switch (event.eventName) {
    case "RoundStarted":
      await query(
        `INSERT INTO game_rounds (
           round_id, start_slot, end_slot, status, source_signature
         )
         VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (round_id)
         DO UPDATE SET
           start_slot = EXCLUDED.start_slot,
           end_slot = EXCLUDED.end_slot,
           status = 'active',
           source_signature = COALESCE(EXCLUDED.source_signature, game_rounds.source_signature),
           updated_at = NOW()`,
        [event.roundId, event.startSlot, event.endSlot, signature ?? null],
      );
      break;

    case "PlayerDeployed":
      await query(
        `INSERT INTO player_deployments (
           round_id, wallet_address, points_deployed, deployed_at, source_signature
         )
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (round_id, wallet_address)
         DO UPDATE SET
           points_deployed = EXCLUDED.points_deployed,
           deployed_at = EXCLUDED.deployed_at,
           source_signature = COALESCE(EXCLUDED.source_signature, player_deployments.source_signature),
           updated_at = NOW()`,
        [
          event.roundId,
          event.walletAddress,
          event.pointsDeployed,
          signature ?? null,
        ],
      );
      await query(
        `UPDATE game_rounds
            SET player_count = (
                  SELECT COUNT(*)::int
                    FROM player_deployments
                   WHERE round_id = $1
                ),
                updated_at = NOW()
          WHERE round_id = $1`,
        [event.roundId],
      );
      break;

    case "RoundSettled": {
      // Post-F3: RoundSettled carries only the snapshot fields. Per-player
      // hit / reward accrue later via CheckpointRecorded. Refund-mode rounds
      // are surfaced as 'skipped' so the /v1/game/round/:id/status endpoint
      // can steer the client to the refund-claim flow.
      const status: GameRoundStatus = event.refundMode
        ? GameRoundStatus.Skipped
        : GameRoundStatus.Settled;
      await query(
        `UPDATE game_rounds
            SET status = $2,
                settle_timestamp = $3,
                expires_at = $4,
                refund_mode = $5,
                total_points_deployed = $6,
                settled_at = NOW(),
                source_signature = COALESCE($7, source_signature),
                updated_at = NOW()
          WHERE round_id = $1`,
        [
          event.roundId,
          status,
          event.settleTimestamp,
          event.expiresAt,
          event.refundMode,
          event.totalPointsDeployed,
          signature ?? null,
        ],
      );
      // Synthesise per-player (is_hit, reward_amount, motherlode_share)
      // off-chain so the /v1/game/round/:id/status endpoint can surface
      // the outcome before CheckpointRecorded arrives. Reconciled later
      // when CheckpointRecorded overwrites is_hit/reward_amount with the
      // authoritative on-chain values.
      //
      // BEST-EFFORT: `slot_hash` is NOT carried in the RoundSettled event
      // payload. The keeper / backfill path is expected to persist it on
      // the game_rounds row out-of-band (see game_rounds.slot_hash —
      // migration 038). Rounds without a stored slot_hash are skipped
      // silently; CheckpointRecorded remains the source of truth in that
      // case. Once F6 lands the cranker we can drop this best-effort
      // branch entirely.
      await synthesiseRoundOutcomes(event);
      break;
    }

    case "CheckpointRecorded": {
      // Authoritative per-player outcome. Overwrites any row synthesized
      // off-chain before the checkpoint instruction landed.
      //
      // Dedup protocol (code-review Fix C): the RPC logsSubscribe stream
      // can re-deliver a CheckpointRecorded log after a reconnect. The
      // per-player `player_deployments` row is idempotent under
      // ON CONFLICT, but the sibling `game_rounds` counters
      // (`hit_count`, `tokens_minted`) are NOT — incrementing them
      // unconditionally would double-count on every replay. Gate the
      // counter update on the upsert being a first-time settle: the
      // ON CONFLICT update only fires when the existing row has
      // `settled = false`, and RETURNING bubbles a row up to the CTE
      // only in that case. A replayed event finds settled=true, the
      // DO UPDATE is skipped, RETURNING is empty, and the counter stays
      // put. `xmax = 0` distinguishes an insert from an update so we can
      // surface the first-settle signal cleanly to the caller/tests.
      const upsertRes = await query<{ wallet_address: string }>(
        `INSERT INTO player_deployments (
           round_id, wallet_address, is_hit, reward_amount, settled,
           source_signature
         )
         VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (round_id, wallet_address)
         DO UPDATE SET
           is_hit = EXCLUDED.is_hit,
           reward_amount = EXCLUDED.reward_amount,
           settled = true,
           source_signature = COALESCE(EXCLUDED.source_signature, player_deployments.source_signature),
           updated_at = NOW()
         WHERE player_deployments.settled = false
         RETURNING wallet_address`,
        [
          event.roundId,
          event.walletAddress,
          event.isHit,
          event.rewardAmount,
          signature ?? null,
        ],
      );
      // Roll hit counters on the round for observability parity with
      // process_checkpoint_round's on-chain write — only on the first
      // successful settle. Empty RETURNING ⇒ replay, skip.
      if (upsertRes.rowCount && upsertRes.rowCount > 0 && event.isHit) {
        await query(
          `UPDATE game_rounds
              SET hit_count = hit_count + 1,
                  tokens_minted = tokens_minted + $2::bigint,
                  updated_at = NOW()
            WHERE round_id = $1`,
          [event.roundId, event.rewardAmount],
        );
      }
      break;
    }

    case "MotherlodeTriggered":
      // Post-F3 payload is round_id + motherlode_amount only; refund_mode
      // was set by the accompanying RoundSettled event.
      await query(
        `UPDATE game_rounds
            SET motherlode_triggered = true,
                motherlode_amount = $2,
                updated_at = NOW()
          WHERE round_id = $1`,
        [event.roundId, event.motherlodeAmount],
      );
      break;

    case "RewardClaimed":
      await query(
        `UPDATE player_deployments
            SET claimed = true,
                reward_amount = $3,
                updated_at = NOW()
          WHERE round_id = $1 AND wallet_address = $2`,
        [event.roundId, event.walletAddress, event.amount],
      );
      break;
  }
}
