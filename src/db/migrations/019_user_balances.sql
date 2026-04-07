CREATE TABLE user_balances (
    wallet_address TEXT PRIMARY KEY,
    total_earned BIGINT DEFAULT 0,
    total_pending BIGINT DEFAULT 0,
    total_spent BIGINT DEFAULT 0,
    total_reserved BIGINT DEFAULT 0,
    usable_balance BIGINT GENERATED ALWAYS AS (total_earned - total_spent - total_reserved) STORED,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_user_balances_usable ON user_balances(usable_balance DESC);
