-- Migration 050 — Deposit vaults registry for campaign incentive funding.
--
-- Spec'd as `037_deposit_vaults.sql` in the campaign-incentives outline, but
-- migrations 037–049 are already taken (most recently 049_provider_catalog.sql
-- from Task 10). Renumbered to 050 to land at the current head; no schema
-- delta from the spec.
--
-- Each row is the off-chain mirror of one program-owned SPL Token-2022 vault
-- holding incentive deposits for a (protocol, campaign, mint) tuple. The
-- vault token account is owned by `vault_authority_pda`, a PDA derived from
-- seeds [DEPOSIT_VAULT_AUTH_SEED, protocol_authority, campaign_id_bytes]
-- (see Task 5 program handler). Custody is therefore wholly on-chain — this
-- table is a registry the API and keeper bot read from; it does not control
-- spend.
--
-- `campaign_id` is NULLABLE on purpose. The funding flow (Task 21) lets a
-- protocol admin pre-fund a vault before a campaign row exists in the DB,
-- and lets generic per-protocol vaults exist that aren't tied to a single
-- campaign (drained back to admin via the close-vault path). When a campaign
-- is later created and bound to the vault, this column is updated. If the
-- campaign is deleted, we keep the vault record (ON DELETE SET NULL) because
-- the on-chain account still exists and may still hold tokens.
--
-- `balance_cached` is a denormalised mirror of the on-chain SPL token account
-- amount. It is written by the keeper bot's distribution loop (the same loop
-- that pays out per-action rewards) and a dedicated balance-watcher cron;
-- never trust it for authorisation decisions — always re-read on-chain before
-- a CPI transfer. It exists for cheap admin-console reads ("show me my
-- vault balances") without an RPC fan-out.
--
-- Status state machine:
--   active   — accepting deposits, paying out
--   draining — admin has initiated close; new deposits blocked, payouts ok
--   closed   — on-chain account closed, balance_cached should be 0

CREATE TABLE IF NOT EXISTS deposit_vaults (
    id                   BIGSERIAL       PRIMARY KEY,
    protocol_id          UUID            NOT NULL
                                         REFERENCES protocols(id) ON DELETE CASCADE,
    campaign_id          UUID            REFERENCES campaigns(campaign_id) ON DELETE SET NULL,
    mint                 TEXT            NOT NULL,
    vault_token_account  TEXT            NOT NULL,
    vault_authority_pda  TEXT            NOT NULL,
    balance_cached       BIGINT          NOT NULL DEFAULT 0,
    status               TEXT            NOT NULL DEFAULT 'active',
    created_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT deposit_vaults_status_chk
        CHECK (status IN ('active', 'draining', 'closed')),
    CONSTRAINT deposit_vaults_balance_nonneg_chk
        CHECK (balance_cached >= 0),
    CONSTRAINT deposit_vaults_vault_token_account_unique
        UNIQUE (vault_token_account)
);

-- Uniqueness on (protocol_id, campaign_id, mint) is split into two partial
-- indexes because PostgreSQL's default UNIQUE constraint treats NULLs as
-- distinct, which would let an attacker register multiple "no-campaign"
-- vaults for the same (protocol, mint).
CREATE UNIQUE INDEX IF NOT EXISTS deposit_vaults_protocol_campaign_mint_uniq
    ON deposit_vaults (protocol_id, campaign_id, mint)
    WHERE campaign_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS deposit_vaults_protocol_mint_no_campaign_uniq
    ON deposit_vaults (protocol_id, mint)
    WHERE campaign_id IS NULL;

CREATE INDEX IF NOT EXISTS deposit_vaults_protocol_id_idx
    ON deposit_vaults (protocol_id);

CREATE INDEX IF NOT EXISTS deposit_vaults_active_idx
    ON deposit_vaults (protocol_id)
    WHERE status = 'active';
