-- 041 — Colosseum Rewardz League: referrals, airdrop signups, visibility enum.
--
-- Enables `pgcrypto` so airdrop emails can be encrypted at rest using
-- `AIRDROP_EMAIL_KEY` (per mini-app-spec.md). Creates the `visibility` enum and
-- adds the corresponding column to `protocols` (deferred from 039 so the column
-- and the type land atomically).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Visibility state machine: `active` | `at_risk` | `hidden`
-- See league-config.md §Visibility for transition rules. `/intents/resolve`
-- excludes `hidden` and down-ranks `at_risk`.
DO $$ BEGIN
    CREATE TYPE visibility_enum AS ENUM ('active', 'at_risk', 'hidden');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE protocols
    ADD COLUMN IF NOT EXISTS visibility visibility_enum NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS protocols_visibility_idx
    ON protocols (visibility);

-- Referral attribution: which protocol referred a given wallet.
-- First-wins, immutable — enforced by the UNIQUE(wallet) constraint. Subsequent
-- attempts to attribute the same wallet are no-ops (ON CONFLICT DO NOTHING in
-- the API layer).
CREATE TABLE referrals (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL UNIQUE,
    protocol_id UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    referral_code TEXT NOT NULL,
    attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX referrals_protocol_idx ON referrals (protocol_id);
CREATE INDEX referrals_code_idx ON referrals (referral_code);

-- Airdrop signup list. Email stored encrypted via pgcrypto pgp_sym_encrypt
-- using `AIRDROP_EMAIL_KEY`. Never insert plaintext.
CREATE TABLE airdrop_signups (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL UNIQUE,
    email_encrypted BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
