-- 052b — Campaigns: reward_method + reward_amount + reward_token_mint (file 2/3 of campaigns extension).
--
-- File 2 of 3 in the campaigns-extension trio:
--   * 052a — action_type CHECK + provider columns (Task 13, landed)
--   * 052b (this file) — reward columns (Task 14)
--   * 052c — funding columns (Task 15)
--
-- Reward method matrix from plan §2: {tokens|points} × {per_day|per_action}.
-- per_day for non-Token-Holding actions is gated by
-- provider_catalog.supports_positions=TRUE (validation enforced in Task 23
-- wizard route, not here). Token Holding always supports per_day via direct
-- RPC mint-balance read.
--
-- reward_amount semantics:
--   * tokens: smallest unit of the reward mint (e.g. 1_000_000 = 1 USDC if 6 decimals)
--   * points: shared-platform-points base unit (1 unit per point)
--
-- reward_token_mint is the SPL Token-2022 mint pubkey when reward_method
-- begins with 'tokens_'; NULL when reward_method begins with 'points_'.
-- Mint owner must be Token-2022 program — runtime check enforced in
-- IX_REGISTER_CAMPAIGN handler (Task 4) AND wizard validation (Task 23).

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS reward_method TEXT,
    ADD COLUMN IF NOT EXISTS reward_amount BIGINT,
    ADD COLUMN IF NOT EXISTS reward_token_mint TEXT;

-- CHECK reward_method enum (4 documented combinations) — guarded so
-- existing rows without a reward_method (legacy IDL flow) aren't blocked.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_reward_method_chk'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM campaigns
            WHERE reward_method IS NOT NULL
              AND reward_method NOT IN
                ('tokens_per_day', 'tokens_per_action', 'points_per_day', 'points_per_action')
        ) THEN
            RAISE EXCEPTION 'campaigns has rows with reward_method NOT IN '
                '(tokens_per_day, tokens_per_action, points_per_day, points_per_action); '
                'migrate those rows before re-running 052b';
        END IF;

        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_reward_method_chk
                CHECK (reward_method IS NULL OR reward_method IN
                    ('tokens_per_day', 'tokens_per_action', 'points_per_day', 'points_per_action'));
    END IF;
END $$;

-- CHECK invariants between reward_method and reward_token_mint:
--   * tokens_* requires reward_token_mint NOT NULL
--   * points_* requires reward_token_mint NULL (the points pool funds it)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_reward_mint_consistency_chk'
    ) THEN
        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_reward_mint_consistency_chk
                CHECK (
                    reward_method IS NULL
                    OR (reward_method LIKE 'tokens_%' AND reward_token_mint IS NOT NULL)
                    OR (reward_method LIKE 'points_%' AND reward_token_mint IS NULL)
                );
    END IF;
END $$;

-- CHECK reward_amount > 0 when present (no free campaigns)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_reward_amount_pos_chk'
    ) THEN
        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_reward_amount_pos_chk
                CHECK (reward_amount IS NULL OR reward_amount > 0);
    END IF;
END $$;
