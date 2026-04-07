CREATE TABLE rental_settlements (
    id SERIAL PRIMARY KEY,
    rental_pda TEXT NOT NULL,
    user_wallet TEXT NOT NULL,
    protocol_wallet TEXT NOT NULL,
    amount_settled BIGINT NOT NULL,
    tx_signature TEXT UNIQUE,
    status TEXT DEFAULT 'confirmed',
    settled_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_rental_settlements_pda ON rental_settlements(rental_pda);
