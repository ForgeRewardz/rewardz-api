import { query, pool } from "../db/client.js";
import type { UserBalance, PointEvent } from "../types/index.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface PointAwardResult {
  success: boolean;
  event_id?: string;
  new_balance?: bigint;
  duplicate?: boolean;
}

export interface BatchAwardItem {
  wallet: string;
  amount: bigint;
  protocolId: string;
  idempotencyKey: string;
  reason?: string;
}

export interface BatchItemResult {
  wallet: string;
  success: boolean;
  event_id?: string;
  new_balance?: bigint;
  duplicate?: boolean;
  error?: string;
}

export interface BatchResult {
  total: number;
  succeeded: number;
  duplicates: number;
  failed: number;
  results: BatchItemResult[];
}

/* -------------------------------------------------------------------------- */
/*  awardPoints                                                               */
/* -------------------------------------------------------------------------- */

export async function awardPoints(
  wallet: string,
  amount: bigint,
  protocolId: string | null,
  source: { type: "signature" | "reference" | "completion"; key: string },
  reason?: string,
): Promise<PointAwardResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Idempotency check: determine the column to use
    const sourceColumn =
      source.type === "signature"
        ? "source_signature"
        : source.type === "reference"
          ? "source_reference"
          : "source_reference";

    // Check for duplicate
    const dupCheck = await client.query<{ id: string }>(
      `SELECT id FROM point_events WHERE ${sourceColumn} = $1 LIMIT 1`,
      [source.key],
    );

    if (dupCheck.rowCount && dupCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return { success: true, event_id: dupCheck.rows[0].id, duplicate: true };
    }

    // Ensure user exists
    await client.query(
      `INSERT INTO users (wallet_address, total_points, synced_points)
       VALUES ($1, 0, 0)
       ON CONFLICT (wallet_address) DO NOTHING`,
      [wallet],
    );

    // Ensure user_balances row exists
    await client.query(
      `INSERT INTO user_balances (wallet_address, total_earned, total_pending, total_spent, total_reserved)
       VALUES ($1, 0, 0, 0, 0)
       ON CONFLICT (wallet_address) DO NOTHING`,
      [wallet],
    );

    // Insert point event
    const signatureVal = source.type === "signature" ? source.key : null;
    const referenceVal =
      source.type === "reference" || source.type === "completion"
        ? source.key
        : null;

    const insertResult = await client.query<{ id: string }>(
      `INSERT INTO point_events (user_wallet, protocol_id, type, amount, source_signature, source_reference, reason)
       VALUES ($1, $2, 'awarded', $3, $4, $5, $6)
       RETURNING id`,
      [wallet, protocolId, amount, signatureVal, referenceVal, reason ?? null],
    );

    const eventId = insertResult.rows[0].id;

    // Update user_balances and atomically retrieve totals via RETURNING
    const balResult = await client.query<{
      total_earned: string;
      total_spent: string;
      total_reserved: string;
    }>(
      `UPDATE user_balances
       SET total_earned = total_earned + $2,
           updated_at = NOW()
       WHERE wallet_address = $1
       RETURNING total_earned, total_spent, total_reserved`,
      [wallet, amount],
    );

    // RECONCILIATION: Update users.total_points from atomic RETURNING values
    // Use usable_balance formula: total_earned - total_spent - total_reserved
    const totalEarned = BigInt(balResult.rows[0].total_earned);
    const totalSpent = BigInt(balResult.rows[0].total_spent);
    const totalReserved = BigInt(balResult.rows[0].total_reserved);
    const newBalance = totalEarned - totalSpent - totalReserved;

    await client.query(
      `UPDATE users
       SET total_points = $2,
           updated_at = NOW()
       WHERE wallet_address = $1`,
      [wallet, newBalance],
    );

    await client.query("COMMIT");

    return {
      success: true,
      event_id: eventId,
      new_balance: newBalance,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/*  getBalance                                                                */
/* -------------------------------------------------------------------------- */

export async function getBalance(wallet: string): Promise<UserBalance | null> {
  const result = await query<{
    wallet_address: string;
    total_earned: string;
    total_pending: string;
    total_spent: string;
    total_reserved: string;
    usable_balance: string;
    updated_at: Date;
  }>(
    `SELECT wallet_address, total_earned, total_pending, total_spent, total_reserved, usable_balance, updated_at
     FROM user_balances
     WHERE wallet_address = $1`,
    [wallet],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  return {
    wallet_address: row.wallet_address,
    total_earned: BigInt(row.total_earned),
    total_pending: BigInt(row.total_pending),
    total_spent: BigInt(row.total_spent),
    total_reserved: BigInt(row.total_reserved),
    usable_balance: BigInt(row.usable_balance),
    updated_at: row.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  getHistory                                                                */
/* -------------------------------------------------------------------------- */

export async function getHistory(
  wallet: string,
  limit: number,
  offset: number,
): Promise<PointEvent[]> {
  const result = await query<{
    id: string;
    user_wallet: string;
    protocol_id: string | null;
    type: string;
    amount: string;
    completion_id: string | null;
    source_signature: string | null;
    source_reference: string | null;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT id, user_wallet, protocol_id, type, amount, completion_id, source_signature, source_reference, reason, created_at
     FROM point_events
     WHERE user_wallet = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [wallet, limit, offset],
  );

  return result.rows.map((row) => ({
    id: row.id,
    user_wallet: row.user_wallet,
    protocol_id: row.protocol_id,
    type: row.type as PointEvent["type"],
    amount: BigInt(row.amount),
    completion_id: row.completion_id,
    source_signature: row.source_signature,
    source_reference: row.source_reference,
    reason: row.reason,
    created_at: row.created_at,
  }));
}

/* -------------------------------------------------------------------------- */
/*  batchAward                                                                */
/* -------------------------------------------------------------------------- */

export async function batchAward(
  awards: BatchAwardItem[],
): Promise<BatchResult> {
  if (awards.length > 100) {
    throw new Error("Batch size must not exceed 100");
  }

  const results: BatchItemResult[] = [];
  let succeeded = 0;
  let duplicates = 0;
  let failed = 0;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const award of awards) {
      try {
        // Idempotency check
        const dupCheck = await client.query<{ id: string }>(
          `SELECT id FROM point_events WHERE source_reference = $1 LIMIT 1`,
          [award.idempotencyKey],
        );

        if (dupCheck.rowCount && dupCheck.rowCount > 0) {
          duplicates++;
          results.push({
            wallet: award.wallet,
            success: true,
            event_id: dupCheck.rows[0].id,
            duplicate: true,
          });
          continue;
        }

        // Ensure user exists
        await client.query(
          `INSERT INTO users (wallet_address, total_points, synced_points)
           VALUES ($1, 0, 0)
           ON CONFLICT (wallet_address) DO NOTHING`,
          [award.wallet],
        );

        // Ensure user_balances row exists
        await client.query(
          `INSERT INTO user_balances (wallet_address, total_earned, total_pending, total_spent, total_reserved)
           VALUES ($1, 0, 0, 0, 0)
           ON CONFLICT (wallet_address) DO NOTHING`,
          [award.wallet],
        );

        // Insert point event
        const insertResult = await client.query<{ id: string }>(
          `INSERT INTO point_events (user_wallet, protocol_id, type, amount, source_reference, reason)
           VALUES ($1, $2, 'awarded', $3, $4, $5)
           RETURNING id`,
          [
            award.wallet,
            award.protocolId,
            award.amount,
            award.idempotencyKey,
            award.reason ?? null,
          ],
        );

        const eventId = insertResult.rows[0].id;

        // Update user_balances and atomically retrieve totals via RETURNING
        const balResult = await client.query<{
          total_earned: string;
          total_spent: string;
          total_reserved: string;
        }>(
          `UPDATE user_balances
           SET total_earned = total_earned + $2,
               updated_at = NOW()
           WHERE wallet_address = $1
           RETURNING total_earned, total_spent, total_reserved`,
          [award.wallet, award.amount],
        );

        // RECONCILIATION: Update users.total_points from atomic RETURNING values
        const totalEarned = BigInt(balResult.rows[0].total_earned);
        const totalSpent = BigInt(balResult.rows[0].total_spent);
        const totalReserved = BigInt(balResult.rows[0].total_reserved);
        const newBalance = totalEarned - totalSpent - totalReserved;

        await client.query(
          `UPDATE users
           SET total_points = $2,
               updated_at = NOW()
           WHERE wallet_address = $1`,
          [award.wallet, newBalance],
        );

        succeeded++;
        results.push({
          wallet: award.wallet,
          success: true,
          event_id: eventId,
          new_balance: newBalance,
        });
      } catch (err) {
        failed++;
        results.push({
          wallet: award.wallet,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        // Re-throw to rollback the entire batch
        throw err;
      }
    }

    await client.query("COMMIT");
  } catch (_err) {
    await client.query("ROLLBACK");

    // Rollback semantics: the tx rolled back, so every "success" or
    // "duplicate" row previously pushed to `results` never actually landed
    // in the database. We must re-mark them as failed and zero out the
    // success/duplicate counters so the returned BatchResult reflects the
    // fact that nothing was committed.
    succeeded = 0;
    duplicates = 0;
    failed = 0;
    for (let i = 0; i < results.length; i++) {
      const prev = results[i];
      if (prev.success) {
        results[i] = {
          wallet: prev.wallet,
          success: false,
          error: "Batch rolled back due to earlier failure",
        };
      }
      failed++;
    }

    // If we haven't recorded every item yet (the throw happened before the
    // failing item was pushed), pad the remainder as failed.
    if (results.length < awards.length) {
      for (let i = results.length; i < awards.length; i++) {
        failed++;
        results.push({
          wallet: awards[i].wallet,
          success: false,
          error: "Batch rolled back due to earlier failure",
        });
      }
    }
  } finally {
    client.release();
  }

  return {
    total: awards.length,
    succeeded,
    duplicates,
    failed,
    results,
  };
}
