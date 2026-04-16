-- 039 — Colosseum Rewardz League: add per-protocol league state columns.
--
-- Introduces issuance-capacity accounting (remaining_capacity, capacity_window_start),
-- wallet self-declaration (founder_wallets, team_wallets — drive anti-abuse weighting),
-- and the referral code surface. The `visibility` column is added in migration 041
-- after its enum type is created there.
--
-- Repurposes the existing `quality_score` column by tightening precision to 5,4 so the
-- quality-score cron (hourly) can store values in [0.0, 1.0] without rounding noise.

-- remaining_capacity is nullable: NULL means "not yet initialised by the
-- capacity bootstrap" so the milestone-processor can distinguish a brand-new
-- protocol awaiting its starter grant from one that has genuinely exhausted
-- its window. A NOT NULL DEFAULT 0 would silently freeze legacy protocols.
-- Bootstrap path: see api/src/services/league-capacity-bootstrap.ts (task 12).
ALTER TABLE protocols
    ADD COLUMN IF NOT EXISTS remaining_capacity BIGINT,
    ADD COLUMN IF NOT EXISTS capacity_window_start TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS referral_code TEXT,
    ADD COLUMN IF NOT EXISTS founder_wallets TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS team_wallets TEXT[] NOT NULL DEFAULT '{}';

-- Uniqueness enforced by partial index so NULL codes (protocols that have not
-- yet joined the league) do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS protocols_referral_code_unique
    ON protocols (referral_code)
    WHERE referral_code IS NOT NULL;

-- quality_score already exists (DECIMAL DEFAULT 0.5) from migration 003.
-- Tighten the type to match league-config.md §quality-score which mandates the
-- score live in [0.0, 1.0] with 4 decimal places. Pre-clamp + round so any
-- legacy out-of-range values (the column was unbounded DECIMAL) are coerced
-- into range instead of failing the migration. LEAST/GREATEST guard the upper
-- and lower bounds; ROUND limits scale to 4. Without this USING clause the
-- ALTER would error on values >= 10.0000 or with >4 fractional digits.
ALTER TABLE protocols
    ALTER COLUMN quality_score TYPE DECIMAL(5,4)
    USING ROUND(GREATEST(0, LEAST(quality_score, 1))::numeric, 4);
