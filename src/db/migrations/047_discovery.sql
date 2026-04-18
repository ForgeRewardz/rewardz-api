-- Migration 047 — Discovery: per-wallet quota, scheduled queries, results.
--
-- Backs the mini-app discovery surface described in mini-app-ux-spec.md §7
-- (and referenced from §6). Three tables, all idempotent via
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS:
--
--   * discovery_usage       — per-wallet, per-UTC-day free-search counter.
--   * discovery_schedules   — user-scheduled discovery runs with a
--                             pending/running/done/cancelled/missed state
--                             machine. `bullmq_id` links each row to its
--                             BullMQ job so cancellation removes both.
--   * discovery_results     — output of a completed scheduled run,
--                             one-to-one with discovery_schedules.
--
-- The `gen_random_uuid()` default for discovery_schedules.id relies on
-- pgcrypto, which was enabled in migration 041 (referrals/airdrop). No
-- new extension is required here.

CREATE TABLE IF NOT EXISTS discovery_usage (
    wallet  TEXT    NOT NULL,
    day_utc DATE    NOT NULL,
    used    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (wallet, day_utc)
);

CREATE TABLE IF NOT EXISTS discovery_schedules (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet     TEXT NOT NULL,
    text       TEXT NOT NULL,
    run_at     TIMESTAMPTZ NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','done','cancelled','missed')),
    bullmq_id  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovery_schedules_wallet_status
    ON discovery_schedules (wallet, status);

-- Supports the stale-schedule scanner (§17): pending/running rows whose
-- run_at has passed need to be reaped or marked 'missed' on worker boot.
CREATE INDEX IF NOT EXISTS idx_discovery_schedules_due
    ON discovery_schedules (run_at)
    WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS discovery_results (
    schedule_id  UUID        NOT NULL REFERENCES discovery_schedules(id) ON DELETE CASCADE,
    assistant    JSONB       NOT NULL,
    matches      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    fell_back    BOOLEAN     NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (schedule_id)
);
