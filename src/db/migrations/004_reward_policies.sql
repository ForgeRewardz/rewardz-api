CREATE TABLE reward_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID REFERENCES protocols(id),
    intent_type TEXT NOT NULL,
    points INTEGER NOT NULL,
    eligibility JSONB DEFAULT '{}',
    budget_max_awards INTEGER,
    budget_awarded_count INTEGER DEFAULT 0,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
