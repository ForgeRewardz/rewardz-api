-- Seed: Rewardz protocol + wallet-connect campaign.
--
-- Idempotent seed that ensures the Rewardz platform itself is represented as
-- a row in `protocols`, and that the default wallet-connect bonus campaign
-- exists in `campaigns`. Referenced by mini-app-ux-spec.md §6 — the mini-app
-- needs a stable protocol_id/campaign_id pair to award 100 points on the
-- first successful wallet connect.
--
-- Deterministic UUIDs are used so application code and tests can reference
-- the rows by constant ID. The `id` / `campaign_id` value is the idempotency
-- anchor for each ON CONFLICT clause below (matching the convention used in
-- `src/db/seed.ts`):
--
--   protocols.id           = 00000000-0000-4000-8000-000000000001  (ON CONFLICT target)
--   campaigns.campaign_id  = 00000000-0000-4000-8000-000000000002  (ON CONFLICT target)
--
-- Column list matches the live schema:
--   * protocols  — migration 003_protocols.sql (+ 039/041 additions left
--                  to defaults).
--   * campaigns  — migration 005_campaigns.sql (+ 035_campaigns_extensions.sql
--                  additions, all nullable).
--
-- Both INSERTs use ON CONFLICT DO NOTHING so re-running the seed is safe.

INSERT INTO protocols (
    id,
    admin_wallet,
    name,
    description,
    supported_actions,
    status,
    quality_score
) VALUES (
    '00000000-0000-4000-8000-000000000001',
    'rewardz-platform',
    'Rewardz',
    'The Rewardz mini-app platform itself. This protocol row owns the default wallet-connect campaign and acts as the issuer for platform-level rewards.',
    ARRAY['wallet_connect']::TEXT[],
    'active',
    1.0
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO campaigns (
    campaign_id,
    protocol_id,
    name,
    description,
    action_type,
    points_per_completion,
    max_per_user_per_day,
    status
) VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'Wallet Connect Bonus',
    'Awarded once per wallet on first successful wallet connect in the Rewardz mini-app.',
    'wallet_connect',
    100,
    1,
    'active'
)
ON CONFLICT (campaign_id) DO NOTHING;
