-- Extend the campaigns table with structured config, budget, eligibility,
-- and a last-awarded-at cursor used by the dashboard.
--
-- Notes on the existing 005_campaigns.sql schema:
--   * `status` already exists as TEXT DEFAULT 'active' — we do NOT change
--     its semantics here. Admin pause/resume will reuse it.
--   * `action_url_pattern` already exists, but it is the legacy pattern
--     column. The Phase 5 runtime wants the full GET URL template, which
--     can diverge from the old pattern (e.g. include explicit query
--     params), so we add a new `action_url_template` column instead of
--     reusing `action_url_pattern`. Migrations backfilling the template
--     from the old pattern are deferred to the campaign management work.
--   * `budget_total` / `budget_spent` / `max_per_user_per_day` also
--     already exist as scalars. The new `budget` JSONB is the structured
--     rule object (max awards, max points, per-window caps, etc.) and
--     does not replace the scalar bookkeeping columns.
ALTER TABLE campaigns
    ADD COLUMN verification_config JSONB,
    ADD COLUMN last_awarded_at TIMESTAMPTZ,
    ADD COLUMN action_url_template TEXT,
    ADD COLUMN eligibility JSONB,
    ADD COLUMN budget JSONB;
