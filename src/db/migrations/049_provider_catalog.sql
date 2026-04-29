-- Migration 049 — Provider catalog for Dialect Standard Blinks Library (SBL).
--
-- Source of truth for the campaign incentive wizard's provider
-- selection step. Populated by:
--   (a) a daily snapshot of markets.dial.to/api/v0/markets (source=sbl_markets)
--   (b) a manual seed file (source=manual) for providers SBL Markets
--       has not yet covered (Raydium, Orca, Meteora until SBL adds them)
--
-- supports_positions = TRUE means the provider has SBL Positions API
-- coverage; the wizard greys out per_day reward-method tiles for
-- providers without it (per_day requires position polling). Token
-- Holding always supports per_day via direct RPC mint-balance read,
-- regardless of this flag.
--
-- status = 'live' is the only state that surfaces in the wizard.
-- 'soon' / 'disabled' are filtered out client-side but the row stays
-- so we keep stable ids across snapshots.

CREATE TABLE IF NOT EXISTS provider_catalog (
    slug                 TEXT            PRIMARY KEY,
    display_name         TEXT            NOT NULL,
    action_types         TEXT[]          NOT NULL,
    dial_to_provider_key TEXT,
    blink_base_url       TEXT,
    source               TEXT            NOT NULL,
    supports_positions   BOOLEAN         NOT NULL DEFAULT FALSE,
    last_synced_at       TIMESTAMPTZ,
    status               TEXT            NOT NULL DEFAULT 'live',

    CONSTRAINT provider_catalog_source_chk
        CHECK (source IN ('sbl_markets', 'manual')),
    CONSTRAINT provider_catalog_status_chk
        CHECK (status IN ('live', 'soon', 'disabled')),
    CONSTRAINT provider_catalog_action_types_nonempty
        CHECK (array_length(action_types, 1) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_provider_catalog_status
    ON provider_catalog (status);

CREATE INDEX IF NOT EXISTS idx_provider_catalog_action_types
    ON provider_catalog USING GIN (action_types);

CREATE INDEX IF NOT EXISTS idx_provider_catalog_supports_positions
    ON provider_catalog (supports_positions)
    WHERE supports_positions = TRUE;
