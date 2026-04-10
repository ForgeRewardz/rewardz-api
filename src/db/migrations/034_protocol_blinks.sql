-- protocol_blinks stores compiled blink manifests — one row per
-- (protocol, instruction, fixed-account-set) tuple. The runtime blink
-- route reads manifest_jsonb directly; the other columns support
-- sitemap aggregation, drift detection, and verification dispatch.
CREATE TABLE protocol_blinks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID NOT NULL REFERENCES protocols(id),
    idl_id UUID NOT NULL REFERENCES protocol_idls(id),
    instruction_name TEXT NOT NULL,
    instruction_slug TEXT NOT NULL,
    fixed_accounts_jsonb JSONB NOT NULL,
    -- base58(sha256(sorted(fixed-account-pubkeys).join('')))[0..12];
    -- stable identifier for this exact fixed-account pin so a new pin
    -- produces a new row rather than silently shadowing the old one.
    fixed_accounts_hash TEXT NOT NULL,
    verification_adapter TEXT NOT NULL,
    -- mint_owner_by_account_jsonb records whether each ATA's mint is
    -- legacy SPL or Token-2022. NULL when the instruction has no ATAs.
    mint_owner_by_account_jsonb JSONB,
    manifest_jsonb JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'live'
        CHECK (status IN ('live', 'paused', 'archived')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (protocol_id, instruction_slug, fixed_accounts_hash)
);

-- Sitemap aggregation groups by (protocol_id, status). Partial index
-- would also work but the cardinality is low so a plain composite is
-- simpler.
CREATE INDEX idx_protocol_blinks_protocol_status
    ON protocol_blinks (protocol_id, status);
