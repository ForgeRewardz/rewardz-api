CREATE TABLE users (
    wallet_address TEXT PRIMARY KEY,
    total_points BIGINT NOT NULL DEFAULT 0,
    synced_points BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
