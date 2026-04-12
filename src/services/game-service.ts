import { PublicKey } from "@solana/web3.js";
import { query } from "../db/client.js";

export type GameRoundStatus =
  | "waiting"
  | "active"
  | "settling"
  | "settled"
  | "skipped";

export type MiningResultKind = "pending" | "hit" | "miss" | "skipped";

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
}

function estimatedEndsAt(row: GameRoundRow): string | null {
  if (row.status !== "active" && row.status !== "settling") return null;
  const slotDelta = Number(BigInt(row.end_slot) - BigInt(row.start_slot));
  if (!Number.isFinite(slotDelta) || slotDelta <= 0) return null;
  return new Date(row.created_at.getTime() + slotDelta * 400).toISOString();
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
  };
}

function resultKind(row: PlayerDeploymentRow): MiningResultKind {
  if (!row.settled) return "pending";
  if (row.is_hit === true) return "hit";
  if (row.is_hit === false) return "miss";
  return "skipped";
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
            motherlode_share::text, claimed, settled
       FROM player_deployments
      WHERE round_id = $1 AND wallet_address = $2
      LIMIT 1`,
    [roundId, walletAddress],
  );
  return result.rows[0] ? serialisePlayer(result.rows[0]) : null;
}

export async function getCurrentRound(
  walletAddress?: string,
): Promise<{ round: GameRoundSummary | null; player: PlayerDeploymentStatus | null }> {
  const result = await query<GameRoundRow>(
    `SELECT round_id::text, start_slot::text, end_slot::text, status,
            player_count, game_fee_lamports::text, hit_rate_bps,
            tokens_per_round::text, motherlode_pool::text,
            motherlode_min_threshold::text, motherlode_probability_bps,
            hit_count, total_hit_points::text, tokens_minted::text,
            motherlode_triggered, motherlode_amount::text, created_at
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
): Promise<{ round: GameRoundSummary; player: PlayerDeploymentStatus | null } | null> {
  const result = await query<GameRoundRow>(
    `SELECT round_id::text, start_slot::text, end_slot::text, status,
            player_count, game_fee_lamports::text, hit_rate_bps,
            tokens_per_round::text, motherlode_pool::text,
            motherlode_min_threshold::text, motherlode_probability_bps,
            hit_count, total_hit_points::text, tokens_minted::text,
            motherlode_triggered, motherlode_amount::text, created_at
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
            motherlode_triggered, motherlode_amount::text, created_at
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
              motherlode_triggered, motherlode_amount::text, created_at
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
      hitCount: number;
      tokensMinted: string;
      motherlodeTriggered: boolean;
    }
  | {
      eventName: "PlayerResult";
      roundId: string;
      walletAddress: string;
      isHit: boolean;
      rewardAmount: string;
    }
  | {
      eventName: "MotherlodeTriggered";
      roundId: string;
      motherlodeAmount: string;
      hitCount: number;
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

function readU32(payload: Buffer, offset: number): number {
  if (payload.length < offset + 4) {
    throw new Error(`payload too short for u32 at offset ${offset}`);
  }
  return payload.readUInt32LE(offset);
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
      return {
        eventName,
        roundId: readU64(payload, 0),
        hitCount: readU32(payload, 8),
        tokensMinted: readU64(payload, 12),
        motherlodeTriggered: payload[20] === 1,
      };
    case "PlayerResult":
      return {
        eventName,
        roundId: readU64(payload, 0),
        walletAddress: readPubkey(payload, 8),
        isHit: payload[40] === 1,
        rewardAmount: readU64(payload, 41),
      };
    case "MotherlodeTriggered":
      return {
        eventName,
        roundId: readU64(payload, 0),
        motherlodeAmount: readU64(payload, 8),
        hitCount: readU32(payload, 16),
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

export async function recordGameEvent(
  event: ParsedGameEvent,
  signature?: string,
): Promise<void> {
  const walletAddress =
    "walletAddress" in event ? event.walletAddress : null;
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
      const status: GameRoundStatus =
        event.tokensMinted === "0" ? "skipped" : "settled";
      await query(
        `UPDATE game_rounds
            SET status = $2,
                hit_count = $3,
                tokens_minted = $4,
                motherlode_triggered = $5,
                settled_at = NOW(),
                source_signature = COALESCE($6, source_signature),
                updated_at = NOW()
          WHERE round_id = $1`,
        [
          event.roundId,
          status,
          event.hitCount,
          event.tokensMinted,
          event.motherlodeTriggered,
          signature ?? null,
        ],
      );
      break;
    }

    case "PlayerResult":
      await query(
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
           updated_at = NOW()`,
        [
          event.roundId,
          event.walletAddress,
          event.isHit,
          event.rewardAmount,
          signature ?? null,
        ],
      );
      break;

    case "MotherlodeTriggered":
      await query(
        `UPDATE game_rounds
            SET motherlode_triggered = true,
                motherlode_amount = $2,
                hit_count = $3,
                updated_at = NOW()
          WHERE round_id = $1`,
        [event.roundId, event.motherlodeAmount, event.hitCount],
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
