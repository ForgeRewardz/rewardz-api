-- Migration 044 — extend abuse_flags.kind CHECK to admit
-- 'daily_cap_breach' as a first-class kind.
--
-- Background: anti_abuse.rs needs a stable, queryable kind for
-- daily-cap detections so the (protocol_id, kind) partial UNIQUE
-- from migration 043 doesn't collide 'other' flags from unrelated
-- detectors. Adding the kind to the CHECK constraint preserves the
-- enum-style discipline already in place (migration 040 enumerates
-- the original five kinds) and keeps each kind's open-flag count
-- bounded to one per protocol.
--
-- Postgres does not allow ALTER CONSTRAINT directly; we drop the
-- old check and add a wider one. Both statements are idempotent
-- via IF EXISTS so re-runs are safe.

ALTER TABLE abuse_flags
    DROP CONSTRAINT IF EXISTS abuse_flags_kind_check;

ALTER TABLE abuse_flags
    ADD CONSTRAINT abuse_flags_kind_check
        CHECK (kind IN (
            'cluster_similarity',
            'repetitive_self_use',
            'blink_failure_rate',
            'unused_issuance',
            'daily_cap_breach',
            'other'
        ));
