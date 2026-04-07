CREATE TABLE completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offer_id UUID,
    intent_id UUID,
    user_wallet TEXT NOT NULL,
    protocol_id UUID REFERENCES protocols(id),
    reward_policy_id UUID REFERENCES reward_policies(id),
    expected_reference TEXT UNIQUE NOT NULL,
    expected_action_url TEXT,
    expected_constraints JSONB,
    signature TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting_signature',
    rejection_reason TEXT,
    points_awarded INT,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);
CREATE INDEX idx_completions_wallet ON completions(user_wallet, created_at DESC);
CREATE INDEX idx_completions_status ON completions(status);
CREATE INDEX idx_completions_signature ON completions(signature);
CREATE INDEX idx_completions_reference ON completions(expected_reference);
