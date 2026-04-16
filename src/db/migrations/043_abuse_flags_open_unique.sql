-- Migration 043 — make abuse_flags open-row uniqueness a real constraint.
--
-- Background: migration 040 created `abuse_flags_open_idx ON (protocol_id)
-- WHERE resolved_at IS NULL`, but it is NOT UNIQUE and lacks `kind`. The
-- keeper-bot anti_abuse cron relies on `INSERT … WHERE NOT EXISTS (open
-- row of same kind)` for idempotency; under concurrent ticks (or a
-- restart mid-tick) two detectors could both pass the guard and produce
-- duplicate open flags. This migration adds a partial UNIQUE index
-- covering both columns so the database — not the application — is the
-- source of truth for "one open flag per (protocol, kind)".
--
-- The existing non-unique index on (protocol_id) WHERE resolved_at IS
-- NULL is retained — milestone_processor's freeze gate filters on
-- protocol_id alone and benefits from the narrower index.

CREATE UNIQUE INDEX IF NOT EXISTS abuse_flags_open_unique_idx
    ON abuse_flags (protocol_id, kind)
 WHERE resolved_at IS NULL;
