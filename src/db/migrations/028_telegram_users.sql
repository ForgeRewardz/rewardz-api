CREATE TABLE telegram_users (
    telegram_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    username TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_telegram_users_wallet ON telegram_users(wallet_address);
