-- 040 — Colosseum Rewardz League: new tables.
--
-- Milestone catalogue + reward rows, Rewardz issuance ledger + root-epoch log,
-- wallet-weight assignments (anti-abuse), abuse flags, protocol events (capacity
-- warnings & visibility transitions), and league leaderboard snapshots.
--
-- Note: a `leaderboard_snapshots` table already exists from migration 026 for
-- per-season *user* leaderboards. The league snapshot is distinct (per-protocol,
-- different ranking inputs) so it lives in its own `league_leaderboard_snapshots`
-- table to avoid breaking existing callers.

-- Catalogue of milestone definitions (seeded in api/src/db/seeds/milestones.ts).
CREATE TABLE milestones (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    bucket TEXT NOT NULL CHECK (bucket IN ('activation', 'growth', 'social')),
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX milestones_bucket_idx ON milestones (bucket);

-- Rewardz amount payable on milestone completion (decoupled from the milestone
-- catalogue so a future tuning pass can adjust values without touching predicates).
CREATE TABLE milestone_rewards (
    id BIGSERIAL PRIMARY KEY,
    milestone_id BIGINT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
    rewardz_amount BIGINT NOT NULL CHECK (rewardz_amount >= 0),
    network TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet')),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (milestone_id, network, effective_from)
);

-- Append-only ledger of Rewardz earned by protocols.
-- Claim-pull is authorised against the cumulative sum, not per-row (see
-- rewardz-claim-design.md). `included_in_root_epoch` is backfilled by the
-- publisher cron when the row is first included in a Merkle root.
CREATE TABLE rewardz_earnings (
    id BIGSERIAL PRIMARY KEY,
    protocol_authority TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL,
    milestone_id BIGINT REFERENCES milestones(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    included_in_root_epoch BIGINT
);
CREATE INDEX rewardz_earnings_authority_idx
    ON rewardz_earnings (protocol_authority);
CREATE INDEX rewardz_earnings_pending_idx
    ON rewardz_earnings (protocol_authority)
    WHERE included_in_root_epoch IS NULL;

-- One row per published RewardzRoot. Mirrors the on-chain epoch; drives
-- observability + idempotent restart of the publisher cron.
CREATE TABLE rewardz_root_epochs (
    epoch BIGINT PRIMARY KEY,
    merkle_root BYTEA NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tx_sig TEXT NOT NULL,
    total_included NUMERIC NOT NULL CHECK (total_included >= 0)
);

-- Per-wallet weight factors (founder / team / external / external_repeat_after_gap).
-- The `weight` is a multiplier on the Rewardz accrual per milestone completion.
-- Wallet is uniqued per protocol so the same operator wallet can act for multiple
-- protocols with independent weights.
CREATE TABLE wallet_weights (
    id BIGSERIAL PRIMARY KEY,
    protocol_id UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    wallet TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('founder', 'team', 'external', 'external_repeat_after_gap')),
    weight DECIMAL(5,4) NOT NULL CHECK (weight >= 0.0 AND weight <= 5.0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (protocol_id, wallet)
);

-- Flags raised by the anti-abuse subsystem. When `resolved_at IS NULL` the
-- flag gates Rewardz accrual: milestone-processor refuses to insert new
-- rewardz_earnings rows for the protocol.
CREATE TABLE abuse_flags (
    id BIGSERIAL PRIMARY KEY,
    protocol_id UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (
        'cluster_similarity',
        'repetitive_self_use',
        'blink_failure_rate',
        'unused_issuance',
        'other'
    )),
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    evidence JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX abuse_flags_open_idx
    ON abuse_flags (protocol_id)
    WHERE resolved_at IS NULL;

-- Protocol-lifecycle events (capacity warnings, visibility transitions, etc.).
-- Console + mobile read these for banners. Append-only.
CREATE TABLE protocol_events (
    id BIGSERIAL PRIMARY KEY,
    protocol_id UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX protocol_events_protocol_created_idx
    ON protocol_events (protocol_id, created_at DESC);

-- Daily league leaderboard snapshot. Top-N protocols get the configured
-- leaderboard_bonus_rewardz + `featured = true` honoured by mobile + mini-app.
CREATE TABLE league_leaderboard_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    rank INTEGER NOT NULL CHECK (rank > 0),
    protocol_id UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    unique_wallets BIGINT NOT NULL DEFAULT 0,
    repeat_users BIGINT NOT NULL DEFAULT 0,
    successful_completions BIGINT NOT NULL DEFAULT 0,
    referred_protocols BIGINT NOT NULL DEFAULT 0,
    bonus_awarded BIGINT NOT NULL DEFAULT 0,
    featured BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (snapshot_date, rank),
    UNIQUE (snapshot_date, protocol_id)
);
CREATE INDEX league_leaderboard_snapshots_date_idx
    ON league_leaderboard_snapshots (snapshot_date);
