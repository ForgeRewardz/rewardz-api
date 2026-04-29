-- Migration 051 — Shared points pool, membership ledger, and protocols stake split.
--
-- Spec'd as `038_shared_points.sql` in the campaign-incentives outline, but
-- migrations 037–050 are already taken (most recently 050_deposit_vaults.sql
-- from Task 11). Renumbered to 051 to land at the current head; no schema
-- delta from the spec.
--
-- == Why split active_stake into on_chain_stake / committed_to_shared_points ==
--
-- 046_protocols_active_stake.sql introduced `protocols.active_stake` as the
-- raw mirror of the on-chain `ProtocolStake` PDA total, written by the keeper
-- bot (`mvp-keeper-bot/src/stake_watcher.rs`). The capacity baseline is then
-- derived as `issuance_ratio × active_stake` (see api/src/services/capacity.ts).
--
-- The shared-points opt-in flow (Task 12) lets a protocol commit a portion of
-- its on-chain stake to a shared issuance pool in exchange for shared rewards.
-- The committed portion must be subtracted from the capacity baseline so a
-- protocol cannot double-count the same stake (full capacity locally + a
-- share of the shared pool). To keep the keeper bot's contract simple — it
-- continues to write the raw on-chain total without knowing about pool
-- commitments — we split the column:
--
--   * `on_chain_stake`              = raw PDA total (keeper bot owns writes)
--   * `committed_to_shared_points`  = off-chain commitment (this API owns)
--   * `effective_active_stake`      = on_chain_stake − committed_to_shared_points
--                                     (exposed via the protocols_with_effective_stake
--                                      view; this is what capacity math should read)
--
-- The CHECK invariant `committed_to_shared_points <= on_chain_stake` enforces
-- that you cannot commit more than you have on-chain. COALESCE handles the
-- NULL case from 046 (NULL means "watcher hasn't observed yet"; we treat it
-- as 0 for the bound so a protocol with NULL stake cannot have any non-zero
-- commitment).
--
-- == active_stake call-sites that downstream tasks must update ==
--
-- These TypeScript files currently SELECT `active_stake` directly. After this
-- migration lands they should switch to reading `effective_active_stake` from
-- the `protocols_with_effective_stake` view (or compute it inline). NOT
-- updated in this migration — that is a downstream task in the campaign-
-- incentives outline.
--
--   1. api/src/routes/protocols.ts:803  type field `active_stake: string | null`
--   2. api/src/routes/protocols.ts:810  SELECT `active_stake::text AS active_stake`
--   3. api/src/routes/protocols.ts:879  `proto.active_stake == null ? null : BigInt(...)`
--   4. api/src/routes/protocols.ts:897  `activeStake: proto.active_stake`
--   5. api/src/services/capacity.ts:11  comment: `active_stake > 0` baseline rule
--   6. api/src/services/capacity.ts:14  comment referencing protocols.active_stake
--   7. api/src/services/capacity.ts:74  comment: RETURNING active_stake
--   8. api/src/services/capacity.ts:80  type field `active_stake: string | null`
--   9. api/src/services/capacity.ts:89  SELECT `active_stake::text AS active_stake`
--  10. api/src/services/capacity.ts:100 `res.rows[0].active_stake == null ? ... BigInt`
--  11. api/src/services/capacity.ts:112 comment: baseline = issuance_ratio × active_stake
--
-- The post-rename SELECT must read `effective_active_stake` from the view so
-- capacity math correctly excludes the shared-points commitment. The keeper
-- bot still writes to `on_chain_stake` (its UPDATE statements need the column
-- rename only).
--
-- == Idempotency note ==
--
-- `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` are idempotent.
-- `ALTER TABLE ... RENAME COLUMN` is NOT idempotent before Postgres 15. We
-- guard the rename with a DO-block that checks information_schema for the
-- old column name first, so re-running this migration on a DB that has
-- already applied it is a no-op. The CHECK constraint add is wrapped in a
-- similar guard because Postgres has no `ADD CONSTRAINT IF NOT EXISTS`.

-- ----------------------------------------------------------------------
-- 1. Singleton ledger: shared_points_pool
-- ----------------------------------------------------------------------
-- Single-row table tracking the cumulative committed pool balance across
-- all protocols that opted in. The CHECK (id = 1) enforces singleton-ness
-- at the schema level so we cannot accidentally insert a second row and
-- silently fork the ledger. Seed the row at migration time so callers can
-- always do `UPDATE shared_points_pool SET ...` without first checking
-- existence.
CREATE TABLE IF NOT EXISTS shared_points_pool (
    id              SMALLINT        PRIMARY KEY DEFAULT 1,
    total_committed BIGINT          NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT shared_points_pool_singleton CHECK (id = 1),
    CONSTRAINT shared_points_pool_total_nonneg CHECK (total_committed >= 0)
);

INSERT INTO shared_points_pool (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------
-- 2. Per-protocol opt-in record: shared_points_membership
-- ----------------------------------------------------------------------
-- One row per protocol that has opted into the shared points pool.
-- protocol_id is the PK so a protocol can only have a single active
-- membership; opting out is DELETE, opting back in re-INSERTs (and the
-- API layer is responsible for replaying any commitment delta against
-- shared_points_pool.total_committed). ON DELETE CASCADE so deleting a
-- protocol cleans up the membership row automatically.
CREATE TABLE IF NOT EXISTS shared_points_membership (
    protocol_id     UUID            PRIMARY KEY
                                    REFERENCES protocols(id) ON DELETE CASCADE,
    deposit_amount  BIGINT          NOT NULL,
    opted_in_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT shared_points_membership_deposit_pos CHECK (deposit_amount > 0)
);

-- ----------------------------------------------------------------------
-- 3. protocols rename: active_stake -> on_chain_stake
-- ----------------------------------------------------------------------
-- Guarded so a re-run on an already-migrated DB is a no-op.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'protocols'
          AND column_name = 'active_stake'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'protocols'
          AND column_name = 'on_chain_stake'
    ) THEN
        ALTER TABLE protocols RENAME COLUMN active_stake TO on_chain_stake;
    END IF;
END$$;

-- ----------------------------------------------------------------------
-- 4. protocols.committed_to_shared_points + CHECK invariant
-- ----------------------------------------------------------------------
-- DEFAULT 0 backfills existing rows safely (no protocol has committed
-- anything before this migration). The CHECK is added separately with
-- a guard because Postgres lacks ADD CONSTRAINT IF NOT EXISTS.
ALTER TABLE protocols
    ADD COLUMN IF NOT EXISTS committed_to_shared_points BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'protocols_committed_within_stake_chk'
          AND conrelid = 'protocols'::regclass
    ) THEN
        ALTER TABLE protocols
            ADD CONSTRAINT protocols_committed_within_stake_chk
            CHECK (committed_to_shared_points <= COALESCE(on_chain_stake, 0));
    END IF;
END$$;

-- ----------------------------------------------------------------------
-- 5. effective_active_stake exposed via a view
-- ----------------------------------------------------------------------
-- Chose a VIEW over a STORED generated column for two reasons:
--   * `on_chain_stake` is NULLABLE per 046 (NULL = watcher hasn't observed
--     yet). A stored generated column would persist `NULL - 0 = NULL`,
--     which loses the "treat as 0 for math" semantic the capacity layer
--     wants. Inlining COALESCE in the view keeps NULL semantics where
--     downstream code already handles them (callers fall back to
--     starter_grant_rewardz when the underlying on_chain_stake is NULL).
--   * Generated columns must be recomputed on every UPDATE that touches
--     either source column, doubling write amplification on the keeper
--     bot's hot path (stake_watcher writes on_chain_stake every poll).
--     A view is computed at read time only, where capacity math runs.
--
-- Downstream readers should `SELECT ... FROM protocols_with_effective_stake`
-- instead of `protocols` when they need the post-commitment baseline.
-- The view exposes `p.*` so it is a drop-in replacement aside from the
-- extra column.
CREATE OR REPLACE VIEW protocols_with_effective_stake AS
SELECT
    p.*,
    COALESCE(p.on_chain_stake, 0) - p.committed_to_shared_points
        AS effective_active_stake
FROM protocols p;
