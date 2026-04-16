-- Migration 045 — make leaderboard bonus inserts race-safe.
--
-- Problem: the leaderboard cron (mvp-keeper-bot/src/leaderboard.rs) pays a
-- once-per-day bonus to each top-N protocol by inserting into
-- `rewardz_earnings` with `milestone_id = NULL` and a reason string of the
-- form `leaderboard:YYYY-MM-DD`. Idempotency was enforced only via a
-- NOT EXISTS guard on (protocol_id, reason). Two overlapping tick
-- invocations could both pass the guard and both insert, double-paying.
-- The partial unique index added in migration 042 does NOT cover these
-- rows because it is `WHERE milestone_id IS NOT NULL`.
--
-- Fix: add a second partial unique index keyed on (protocol_id, reason)
-- for the `milestone_id IS NULL` side, so the database (not application
-- code) enforces at-most-one-bonus-per-reason-per-protocol. The cron can
-- then use ON CONFLICT DO NOTHING and derive `reason` from the snapshot
-- row's `snapshot_date` column inside the SQL, eliminating the second
-- failure mode where `chrono::Utc::now().date_naive()` disagreed with
-- Postgres `CURRENT_DATE` when the DB session timezone was not UTC.
--
-- Scope: the index only constrains non-milestone rows. Milestone earnings
-- (milestone_id IS NOT NULL) continue to be governed by migration 042's
-- `(protocol_id, milestone_id)` unique index, and the reason column is
-- free-form for them.

CREATE UNIQUE INDEX IF NOT EXISTS rewardz_earnings_protocol_reason_unique_idx
    ON rewardz_earnings (protocol_id, reason)
 WHERE milestone_id IS NULL;
