-- 052c — Campaigns: deposit_vault_id, shared_points_optin, sbl_blink_url (file 3/3 of campaigns extension).
--
-- File 3 of 3 in the campaigns-extension trio:
--   * 052a — action_type CHECK + provider columns (Task 13, landed)
--   * 052b — reward columns (Task 14, landed)
--   * 052c (this file) — funding columns (Task 15)
--
-- Funding side of the reward method matrix:
--   * tokens_* reward methods are funded by an SPL Token-2022 deposit_vault
--     (deposit_vault_id FK to deposit_vaults registered in Task 11 migration 050)
--   * points_* reward methods are funded by the protocol's shared-platform-points
--     opt-in (shared_points_optin BOOLEAN — debits committed_to_shared_points
--     in Task 22 route via shared_points_membership)
--   * sbl_blink_url is the Dialect SBL action URL (e.g. dial.to/...) that the
--     mini-app's discovery card opens. Populated either from
--     markets.dial.to snapshots (Task 17) or hand-supplied for manual providers.

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS deposit_vault_id BIGINT
        REFERENCES deposit_vaults(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS shared_points_optin BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sbl_blink_url TEXT;

-- Cross-column funding-method invariant:
--   * tokens_* reward_method requires deposit_vault_id NOT NULL
--   * points_* reward_method requires shared_points_optin = TRUE
--   * Either way, NULL reward_method (legacy IDL flow) places no funding constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_funding_consistency_chk'
    ) THEN
        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_funding_consistency_chk
                CHECK (
                    reward_method IS NULL
                    OR (reward_method LIKE 'tokens_%' AND deposit_vault_id IS NOT NULL)
                    OR (reward_method LIKE 'points_%' AND shared_points_optin = TRUE)
                );
    END IF;
END $$;

-- FK lookup index for reverse joins (deposit_vault → campaigns)
CREATE INDEX IF NOT EXISTS idx_campaigns_deposit_vault_id
    ON campaigns (deposit_vault_id)
    WHERE deposit_vault_id IS NOT NULL;
