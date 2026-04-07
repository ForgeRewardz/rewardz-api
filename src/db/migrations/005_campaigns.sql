CREATE TABLE campaigns (
    campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID NOT NULL REFERENCES protocols(id),
    name TEXT NOT NULL,
    description TEXT,
    action_type TEXT NOT NULL,
    action_url_pattern TEXT,
    points_per_completion INTEGER NOT NULL,
    max_per_user_per_day INTEGER DEFAULT 1,
    budget_total BIGINT,
    budget_spent BIGINT DEFAULT 0,
    issuance_source TEXT DEFAULT 'direct',
    awarded_count INT DEFAULT 0,
    start_at TIMESTAMPTZ DEFAULT NOW(),
    end_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
