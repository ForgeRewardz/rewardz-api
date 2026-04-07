CREATE TABLE point_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_wallet TEXT NOT NULL,
    protocol_id UUID REFERENCES protocols(id),
    type TEXT NOT NULL,
    amount BIGINT NOT NULL,
    completion_id UUID REFERENCES completions(id),
    source_signature TEXT UNIQUE,
    source_reference TEXT UNIQUE,
    reward_policy_id UUID REFERENCES reward_policies(id),
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX unique_completion_award ON point_events(completion_id) WHERE type = 'awarded';
CREATE INDEX idx_point_events_wallet ON point_events(user_wallet, created_at DESC);
CREATE INDEX idx_point_events_completion ON point_events(completion_id);
CREATE INDEX idx_point_events_signature ON point_events(source_signature);
