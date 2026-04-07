CREATE TABLE protocol_manifests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID REFERENCES protocols(id),
    intent_type TEXT NOT NULL,
    action_url_template TEXT NOT NULL,
    verification_adapter TEXT NOT NULL,
    reward_policy_id UUID REFERENCES reward_policies(id),
    supported_assets TEXT[],
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
