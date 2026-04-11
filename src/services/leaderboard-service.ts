import type { PoolClient } from "pg";
import { pool, query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Season — a time-bounded leaderboard period.
 *
 * Mirrors the shape of `@rewardz/types` `Season` but keeps `startAt` / `endAt`
 * as native `Date` objects at the service boundary; route handlers coerce to
 * ISO-8601 strings before sending over the wire.
 */
export interface Season {
  id: string;
  name: string;
  description: string | null;
  startAt: Date;
  endAt: Date | null;
  isActive: boolean;
  snapshotTaken: boolean;
}

/**
 * Channel classification for a point-event award. The underlying DB enum has
 * five members, but the leaderboard surface only exposes four — `completion`
 * rolls into `blink_points` per TODO-0016 §3.
 */
export type Channel = "api" | "webhook" | "blink" | "completion" | "tweet";

/**
 * Per-channel points breakdown (bigints serialised as strings at the wire).
 */
export interface PointsBreakdown {
  tweet: string;
  api: string;
  webhook: string;
  /** Includes rolled-up `completion` channel. */
  blink: string;
}

export interface ProtocolLeaderboardEntry {
  protocolId: string;
  protocolName: string;
  protocolLogo: string | null;
  rank: number;
  totalPointsIssued: string;
  breakdown: PointsBreakdown;
  uniqueUsersRewarded: number;
  seasonId: string;
}

export interface UserLeaderboardEntry {
  wallet: string;
  rank: number;
  totalPoints: string;
  breakdown: PointsBreakdown;
  seasonId: string;
}

export interface SnapshotResult {
  protocolsSnapshotted: number;
  usersSnapshotted: number;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a user-facing channel name to the matching `*_points` column on
 * `protocol_scores` / `user_season_scores`. `completion` folds into
 * `blink_points` per the 5→4 rollup contract.
 */
function channelColumn(channel: Channel): "tweet_points" | "api_points" | "webhook_points" | "blink_points" {
  switch (channel) {
    case "tweet":
      return "tweet_points";
    case "api":
      return "api_points";
    case "webhook":
      return "webhook_points";
    case "blink":
    case "completion":
      return "blink_points";
  }
}

/* -------------------------------------------------------------------------- */
/*  Season lookup                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns the currently-active season. If multiple rows have `is_active = true`,
 * returns the most recently started. Returns `null` if no active season exists.
 */
export async function getActiveSeason(): Promise<Season | null> {
  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    start_at: Date;
    end_at: Date | null;
    is_active: boolean;
    snapshot_taken: boolean;
  }>(
    `SELECT id, name, description, start_at, end_at, is_active, snapshot_taken
     FROM leaderboard_seasons
     WHERE is_active = TRUE
     ORDER BY start_at DESC
     LIMIT 1`,
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startAt: row.start_at,
    endAt: row.end_at,
    isActive: row.is_active,
    snapshotTaken: row.snapshot_taken,
  };
}

/* -------------------------------------------------------------------------- */
/*  Score upserts (used by points-service season-score hooks)                 */
/* -------------------------------------------------------------------------- */

/**
 * Increment protocol_scores for the given season + protocol + channel atomically.
 * Creates the row if it doesn't exist (UPSERT on season_id, protocol_id). Also
 * bumps `total_points_issued`. `completion` folds into `blink_points` per the
 * 5→4 channel rollup.
 *
 * IMPORTANT: This function uses the caller-provided pg client so it runs inside
 * the SAME transaction as the point_events insert. The caller passes their
 * active client (from BEGIN...COMMIT); do NOT open a new connection.
 */
export async function upsertProtocolScore(
  client: PoolClient,
  seasonId: string,
  protocolId: string,
  channel: Channel,
  amount: bigint,
  isFirstAwardForUser: boolean,
): Promise<void> {
  const col = channelColumn(channel);
  const uniqueDelta = isFirstAwardForUser ? 1 : 0;

  // INSERT path: seed the correct channel column with `amount`, others 0.
  // UPDATE path: bump the channel column + total_points_issued + unique count.
  await client.query(
    `INSERT INTO protocol_scores (
       season_id, protocol_id, total_points_issued,
       tweet_points, api_points, webhook_points, blink_points,
       unique_users_rewarded, updated_at
     )
     VALUES (
       $1, $2, $3,
       CASE WHEN $4 = 'tweet_points' THEN $3::bigint ELSE 0 END,
       CASE WHEN $4 = 'api_points' THEN $3::bigint ELSE 0 END,
       CASE WHEN $4 = 'webhook_points' THEN $3::bigint ELSE 0 END,
       CASE WHEN $4 = 'blink_points' THEN $3::bigint ELSE 0 END,
       $5, NOW()
     )
     ON CONFLICT (season_id, protocol_id) DO UPDATE
       SET total_points_issued = protocol_scores.total_points_issued + EXCLUDED.total_points_issued,
           tweet_points        = protocol_scores.tweet_points   + EXCLUDED.tweet_points,
           api_points          = protocol_scores.api_points     + EXCLUDED.api_points,
           webhook_points      = protocol_scores.webhook_points + EXCLUDED.webhook_points,
           blink_points        = protocol_scores.blink_points   + EXCLUDED.blink_points,
           unique_users_rewarded = protocol_scores.unique_users_rewarded + EXCLUDED.unique_users_rewarded,
           updated_at          = NOW()`,
    [seasonId, protocolId, amount.toString(), col, uniqueDelta],
  );
}

/**
 * Increment user_season_scores for the given season + wallet + channel.
 * Same channel rollup semantics as {@link upsertProtocolScore}. Same transaction
 * contract — the caller passes their active pg client.
 */
export async function upsertUserSeasonScore(
  client: PoolClient,
  seasonId: string,
  wallet: string,
  channel: Channel,
  amount: bigint,
): Promise<void> {
  const col = channelColumn(channel);

  await client.query(
    `INSERT INTO user_season_scores (
       season_id, user_wallet, total_points,
       tweet_points, api_points, webhook_points, blink_points,
       updated_at
     )
     VALUES (
       $1, $2, $3,
       CASE WHEN $4 = 'tweet_points' THEN $3::bigint ELSE 0 END,
       CASE WHEN $4 = 'api_points' THEN $3::bigint ELSE 0 END,
       CASE WHEN $4 = 'webhook_points' THEN $3::bigint ELSE 0 END,
       CASE WHEN $4 = 'blink_points' THEN $3::bigint ELSE 0 END,
       NOW()
     )
     ON CONFLICT (season_id, user_wallet) DO UPDATE
       SET total_points    = user_season_scores.total_points   + EXCLUDED.total_points,
           tweet_points    = user_season_scores.tweet_points   + EXCLUDED.tweet_points,
           api_points      = user_season_scores.api_points     + EXCLUDED.api_points,
           webhook_points  = user_season_scores.webhook_points + EXCLUDED.webhook_points,
           blink_points    = user_season_scores.blink_points   + EXCLUDED.blink_points,
           updated_at      = NOW()`,
    [seasonId, wallet, amount.toString(), col],
  );
}

/* -------------------------------------------------------------------------- */
/*  Read endpoints                                                            */
/* -------------------------------------------------------------------------- */

interface ProtocolScoreRow {
  protocol_id: string;
  protocol_name: string;
  total_points_issued: string;
  tweet_points: string;
  api_points: string;
  webhook_points: string;
  blink_points: string;
  unique_users_rewarded: number;
  rank: string;
}

function mapProtocolRow(row: ProtocolScoreRow, seasonId: string): ProtocolLeaderboardEntry {
  return {
    protocolId: row.protocol_id,
    protocolName: row.protocol_name,
    // protocols table has no logo column yet (see migration 003);
    // return null so wire contract stays honest.
    protocolLogo: null,
    rank: Number(row.rank),
    totalPointsIssued: BigInt(row.total_points_issued).toString(),
    breakdown: {
      tweet: BigInt(row.tweet_points).toString(),
      api: BigInt(row.api_points).toString(),
      webhook: BigInt(row.webhook_points).toString(),
      blink: BigInt(row.blink_points).toString(),
    },
    uniqueUsersRewarded: row.unique_users_rewarded,
    seasonId,
  };
}

interface UserScoreRow {
  user_wallet: string;
  total_points: string;
  tweet_points: string;
  api_points: string;
  webhook_points: string;
  blink_points: string;
  rank: string;
}

function mapUserRow(row: UserScoreRow, seasonId: string): UserLeaderboardEntry {
  return {
    wallet: row.user_wallet,
    rank: Number(row.rank),
    totalPoints: BigInt(row.total_points).toString(),
    breakdown: {
      tweet: BigInt(row.tweet_points).toString(),
      api: BigInt(row.api_points).toString(),
      webhook: BigInt(row.webhook_points).toString(),
      blink: BigInt(row.blink_points).toString(),
    },
    seasonId,
  };
}

/**
 * Paginated protocol leaderboard for a given season. Joins protocol_scores
 * against protocols for the display name. Orders by `total_points_issued DESC`.
 * `rank` is computed via window function (`ROW_NUMBER OVER ORDER BY`).
 */
export async function getProtocolLeaderboard(
  seasonId: string,
  limit: number,
  offset: number,
): Promise<{ entries: ProtocolLeaderboardEntry[]; total: number }> {
  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM protocol_scores
     WHERE season_id = $1`,
    [seasonId],
  );
  const total = Number(totalResult.rows[0]?.count ?? "0");

  const result = await query<ProtocolScoreRow>(
    `SELECT
       ps.protocol_id,
       p.name                                         AS protocol_name,
       ps.total_points_issued::text                   AS total_points_issued,
       ps.tweet_points::text                          AS tweet_points,
       ps.api_points::text                            AS api_points,
       ps.webhook_points::text                        AS webhook_points,
       ps.blink_points::text                          AS blink_points,
       ps.unique_users_rewarded,
       ROW_NUMBER() OVER (ORDER BY ps.total_points_issued DESC, ps.protocol_id)::text AS rank
     FROM protocol_scores ps
     JOIN protocols p ON p.id = ps.protocol_id
     WHERE ps.season_id = $1
     ORDER BY ps.total_points_issued DESC, ps.protocol_id
     LIMIT $2 OFFSET $3`,
    [seasonId, limit, offset],
  );

  return {
    entries: result.rows.map((row) => mapProtocolRow(row, seasonId)),
    total,
  };
}

/**
 * Paginated user leaderboard for a given season. Orders by `total_points DESC`.
 */
export async function getUserLeaderboard(
  seasonId: string,
  limit: number,
  offset: number,
): Promise<{ entries: UserLeaderboardEntry[]; total: number }> {
  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM user_season_scores
     WHERE season_id = $1`,
    [seasonId],
  );
  const total = Number(totalResult.rows[0]?.count ?? "0");

  const result = await query<UserScoreRow>(
    `SELECT
       user_wallet,
       total_points::text                             AS total_points,
       tweet_points::text                             AS tweet_points,
       api_points::text                               AS api_points,
       webhook_points::text                           AS webhook_points,
       blink_points::text                             AS blink_points,
       ROW_NUMBER() OVER (ORDER BY total_points DESC, user_wallet)::text AS rank
     FROM user_season_scores
     WHERE season_id = $1
     ORDER BY total_points DESC, user_wallet
     LIMIT $2 OFFSET $3`,
    [seasonId, limit, offset],
  );

  return {
    entries: result.rows.map((row) => mapUserRow(row, seasonId)),
    total,
  };
}

/**
 * Get the rank row for a single protocol within a season. Returns `null` if
 * the protocol has no score row for that season.
 */
export async function getProtocolRank(
  protocolId: string,
  seasonId: string,
): Promise<ProtocolLeaderboardEntry | null> {
  const result = await query<ProtocolScoreRow>(
    `WITH ranked AS (
       SELECT
         ps.protocol_id,
         p.name                        AS protocol_name,
         ps.total_points_issued::text  AS total_points_issued,
         ps.tweet_points::text         AS tweet_points,
         ps.api_points::text           AS api_points,
         ps.webhook_points::text       AS webhook_points,
         ps.blink_points::text         AS blink_points,
         ps.unique_users_rewarded,
         ROW_NUMBER() OVER (ORDER BY ps.total_points_issued DESC, ps.protocol_id)::text AS rank
       FROM protocol_scores ps
       JOIN protocols p ON p.id = ps.protocol_id
       WHERE ps.season_id = $1
     )
     SELECT * FROM ranked WHERE protocol_id = $2 LIMIT 1`,
    [seasonId, protocolId],
  );

  if (result.rowCount === 0) return null;
  return mapProtocolRow(result.rows[0], seasonId);
}

/**
 * Get the rank row for a single wallet within a season. Returns `null` if the
 * wallet has no score row for that season.
 */
export async function getUserRank(
  wallet: string,
  seasonId: string,
): Promise<UserLeaderboardEntry | null> {
  const result = await query<UserScoreRow>(
    `WITH ranked AS (
       SELECT
         user_wallet,
         total_points::text       AS total_points,
         tweet_points::text       AS tweet_points,
         api_points::text         AS api_points,
         webhook_points::text     AS webhook_points,
         blink_points::text       AS blink_points,
         ROW_NUMBER() OVER (ORDER BY total_points DESC, user_wallet)::text AS rank
       FROM user_season_scores
       WHERE season_id = $1
     )
     SELECT * FROM ranked WHERE user_wallet = $2 LIMIT 1`,
    [seasonId, wallet],
  );

  if (result.rowCount === 0) return null;
  return mapUserRow(result.rows[0], seasonId);
}

/* -------------------------------------------------------------------------- */
/*  Snapshot                                                                  */
/* -------------------------------------------------------------------------- */

const SNAPSHOT_PROTOCOL_LIMIT = 1000;
const SNAPSHOT_USER_LIMIT = 10_000;

/**
 * Snapshot the current top 1000 protocols and top 10000 users into
 * leaderboard_snapshots. Marks the season's `snapshot_taken = true`.
 *
 * Idempotent: refuses to re-snapshot a season that already has
 * `snapshot_taken = true` and instead returns the existing snapshot counts.
 *
 * Throws a tagged error if the season does not exist so callers can map to a
 * 404 response.
 */
export async function takeSnapshot(seasonId: string): Promise<SnapshotResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the season row so concurrent snapshot calls serialise cleanly.
    const seasonResult = await client.query<{
      id: string;
      snapshot_taken: boolean;
    }>(
      `SELECT id, snapshot_taken
       FROM leaderboard_seasons
       WHERE id = $1
       FOR UPDATE`,
      [seasonId],
    );

    if (seasonResult.rowCount === 0) {
      await client.query("ROLLBACK");
      const err = new Error(`Season ${seasonId} not found`);
      (err as Error & { code?: string }).code = "SEASON_NOT_FOUND";
      throw err;
    }

    if (seasonResult.rows[0].snapshot_taken) {
      // Already snapshotted — surface existing counts and exit idempotently.
      const counts = await client.query<{ type: string; count: string }>(
        `SELECT type, COUNT(*)::text AS count
         FROM leaderboard_snapshots
         WHERE season_id = $1
         GROUP BY type`,
        [seasonId],
      );
      await client.query("COMMIT");

      let protocols = 0;
      let users = 0;
      for (const row of counts.rows) {
        if (row.type === "protocol") protocols = Number(row.count);
        else if (row.type === "user") users = Number(row.count);
      }
      return { protocolsSnapshotted: protocols, usersSnapshotted: users };
    }

    // Fresh snapshot: materialise top-N for each entity type into
    // leaderboard_snapshots. Use window functions to compute rank server-side.
    const protocolInsert = await client.query<{ count: string }>(
      `WITH ranked AS (
         SELECT
           ps.protocol_id,
           p.name                          AS protocol_name,
           ps.total_points_issued,
           ROW_NUMBER() OVER (ORDER BY ps.total_points_issued DESC, ps.protocol_id) AS rank
         FROM protocol_scores ps
         JOIN protocols p ON p.id = ps.protocol_id
         WHERE ps.season_id = $1
       )
       INSERT INTO leaderboard_snapshots (season_id, type, rank, entity_id, entity_name, total_points)
       SELECT $1, 'protocol', rank, protocol_id::text, protocol_name, total_points_issued
       FROM ranked
       WHERE rank <= $2
       RETURNING id`,
      [seasonId, SNAPSHOT_PROTOCOL_LIMIT],
    );

    const userInsert = await client.query<{ count: string }>(
      `WITH ranked AS (
         SELECT
           user_wallet,
           total_points,
           ROW_NUMBER() OVER (ORDER BY total_points DESC, user_wallet) AS rank
         FROM user_season_scores
         WHERE season_id = $1
       )
       INSERT INTO leaderboard_snapshots (season_id, type, rank, entity_id, entity_name, total_points)
       SELECT $1, 'user', rank, user_wallet, NULL, total_points
       FROM ranked
       WHERE rank <= $2
       RETURNING id`,
      [seasonId, SNAPSHOT_USER_LIMIT],
    );

    await client.query(
      `UPDATE leaderboard_seasons
         SET snapshot_taken = TRUE
         WHERE id = $1`,
      [seasonId],
    );

    await client.query("COMMIT");

    return {
      protocolsSnapshotted: protocolInsert.rowCount ?? 0,
      usersSnapshotted: userInsert.rowCount ?? 0,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw err;
  } finally {
    client.release();
  }
}
