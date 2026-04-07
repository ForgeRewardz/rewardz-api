CREATE TABLE point_deductions (
    id SERIAL PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    amount BIGINT NOT NULL,
    mint_attempt_pda TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_point_deductions_wallet ON point_deductions(wallet_address);
