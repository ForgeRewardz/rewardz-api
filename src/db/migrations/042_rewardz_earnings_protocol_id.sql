-- Migration 042 — scope rewardz_earnings to a specific protocol.
--
-- Problem: `rewardz_earnings.protocol_authority` (admin wallet) alone is not
-- a sufficient idempotency key. One admin wallet can own multiple protocols
-- (see `wallet_weights.UNIQUE (protocol_id, wallet)` in 040 which assumes
-- exactly that). Once any protocol earned a milestone, the admin's other
-- protocols were permanently locked out of that milestone because the
-- milestone-processor's NOT EXISTS guard hit on the wallet alone.
--
-- Fix: add `protocol_id UUID` and rekey idempotency on
-- `(protocol_id, milestone_id)`. `protocol_authority` is retained for the
-- publisher — the on-chain leaf is still keyed on the authority wallet, so
-- we still need the wallet column for the Merkle tree build (see task 32).
--
-- Backfill strategy: existing rows (if any) are matched to their protocol
-- via `protocols.admin_wallet = rewardz_earnings.protocol_authority`. If a
-- row's authority maps to more than one protocol the join picks the OLDEST
-- (deterministic) — we log an attention comment so ops can audit.

-- The migration runner wraps each file in a transaction, so no explicit
-- BEGIN/COMMIT is needed here.

ALTER TABLE rewardz_earnings
    ADD COLUMN IF NOT EXISTS protocol_id UUID REFERENCES protocols(id) ON DELETE CASCADE;

-- Backfill from admin_wallet → protocols.id. Pick the oldest matching
-- protocol on collision. In prod (devnet pre-launch) there are zero rows,
-- so this is a no-op; keeping the statement for repeatability.
UPDATE rewardz_earnings re
   SET protocol_id = p.id
  FROM (
    SELECT DISTINCT ON (admin_wallet) id, admin_wallet
      FROM protocols
     ORDER BY admin_wallet, created_at ASC
  ) p
 WHERE re.protocol_id IS NULL
   AND re.protocol_authority = p.admin_wallet;

-- Enforce NOT NULL now that backfill is done. Any row left with NULL
-- means the authority had no matching protocol row — we refuse to ship
-- that state silently.
ALTER TABLE rewardz_earnings
    ALTER COLUMN protocol_id SET NOT NULL;

-- Partial unique index: once a protocol has earned a given milestone, no
-- duplicate row can be inserted. Partial on `milestone_id IS NOT NULL`
-- because non-milestone earnings (e.g. leaderboard bonuses with
-- milestone_id = NULL) are allowed to repeat.
CREATE UNIQUE INDEX IF NOT EXISTS rewardz_earnings_protocol_milestone_unique_idx
    ON rewardz_earnings (protocol_id, milestone_id)
 WHERE milestone_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS rewardz_earnings_protocol_id_idx
    ON rewardz_earnings (protocol_id);
