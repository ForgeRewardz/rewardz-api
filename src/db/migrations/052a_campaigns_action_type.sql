-- 052a — Campaigns: action_type CHECK + provider columns (file 1/3 of campaigns extension).
--
-- This is file 1 of 3 in the campaigns-extension trio for the campaign-incentive
-- wizard:
--   * 052a (this file) — action_type CHECK + provider columns
--   * 052b              — reward columns (Task 14)
--   * 052c              — funding columns (Task 15)
--
-- Add CHECK constraint on the existing action_type column. The plan documents
-- four action types (token_holding | lend_borrow | provide_liquidity |
-- protocol_action). If existing rows hold legacy values (e.g. 'visit_url'
-- from the original IDL onboarding flow), the ADD CONSTRAINT would fail and
-- silently leave the table unconstrained on retry — guard it in a DO-block
-- that bails with a helpful error so deployment fails loudly rather than
-- silently dropping the constraint.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_action_type_chk'
    ) THEN
        -- Verify all existing rows conform before adding the CHECK so the
        -- migration fails with a clear message rather than a generic
        -- check_violation that leaves operators guessing.
        IF EXISTS (
            SELECT 1 FROM campaigns
            WHERE action_type NOT IN
                ('token_holding', 'lend_borrow', 'provide_liquidity', 'protocol_action')
        ) THEN
            RAISE EXCEPTION 'campaigns has rows with action_type NOT IN '
                '(token_holding, lend_borrow, provide_liquidity, protocol_action); '
                'migrate those rows to a documented action_type before re-running 052a';
        END IF;

        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_action_type_chk
                CHECK (action_type IN
                    ('token_holding', 'lend_borrow', 'provide_liquidity', 'protocol_action'));
    END IF;
END $$;

-- Provider columns (referenced by the campaign-incentive wizard step 2).
-- provider_slug references provider_catalog.slug (Task 10 / migration 049),
-- but stay loose with no FK so a campaign created against a not-yet-snapshot
-- provider isn't blocked at insert time. Wizard validation (Task 23) is
-- responsible for confirming the slug exists in provider_catalog.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS provider_slug TEXT,
    ADD COLUMN IF NOT EXISTS provider_vault_id TEXT;

-- Index for the discovery filter (Task 30: GET /v1/discovery/featured?provider=…).
-- Partial index keeps the index small since most campaigns won't have a
-- provider attached.
CREATE INDEX IF NOT EXISTS idx_campaigns_provider_slug
    ON campaigns (provider_slug)
    WHERE provider_slug IS NOT NULL;
