CREATE TABLE game_rounds (
    round_id BIGINT PRIMARY KEY,
    start_slot BIGINT NOT NULL,
    end_slot BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('waiting', 'active', 'settling', 'settled', 'skipped')),
    player_count INTEGER NOT NULL DEFAULT 0,
    game_fee_lamports BIGINT NOT NULL DEFAULT 6000000,
    hit_rate_bps INTEGER NOT NULL DEFAULT 5000,
    tokens_per_round BIGINT NOT NULL DEFAULT 1000,
    motherlode_pool BIGINT NOT NULL DEFAULT 0,
    motherlode_min_threshold BIGINT NOT NULL DEFAULT 0,
    motherlode_probability_bps INTEGER NOT NULL DEFAULT 100,
    hit_count INTEGER NOT NULL DEFAULT 0,
    total_hit_points BIGINT NOT NULL DEFAULT 0,
    tokens_minted BIGINT NOT NULL DEFAULT 0,
    motherlode_triggered BOOLEAN NOT NULL DEFAULT false,
    motherlode_amount BIGINT NOT NULL DEFAULT 0,
    source_signature TEXT,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_game_rounds_status_round_id
    ON game_rounds(status, round_id DESC);

CREATE TABLE player_deployments (
    id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES game_rounds(round_id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    points_deployed BIGINT,
    fee_paid BIGINT,
    deployed_at TIMESTAMPTZ,
    is_hit BOOLEAN,
    reward_amount BIGINT NOT NULL DEFAULT 0,
    motherlode_share BIGINT NOT NULL DEFAULT 0,
    claimed BOOLEAN NOT NULL DEFAULT false,
    settled BOOLEAN NOT NULL DEFAULT false,
    source_signature TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (round_id, wallet_address)
);

CREATE INDEX idx_player_deployments_wallet_round
    ON player_deployments(wallet_address, round_id DESC);

CREATE TABLE game_events (
    id BIGSERIAL PRIMARY KEY,
    event_name TEXT NOT NULL,
    round_id BIGINT,
    wallet_address TEXT,
    signature TEXT,
    payload_jsonb JSONB NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_game_events_round_observed
    ON game_events(round_id, observed_at DESC);
