CREATE TABLE penalty_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID REFERENCES protocols(id),
    type TEXT NOT NULL,
    severity DECIMAL,
    amount_slashed BIGINT,
    capacity_reduction DECIMAL,
    cooldown_until TIMESTAMPTZ,
    reason TEXT NOT NULL,
    admin_wallet TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
