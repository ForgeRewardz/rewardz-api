CREATE TABLE marketing_spends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID REFERENCES protocols(id),
    campaign_id UUID REFERENCES campaigns(campaign_id),
    amount_x BIGINT NOT NULL,
    spend_type TEXT NOT NULL,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
