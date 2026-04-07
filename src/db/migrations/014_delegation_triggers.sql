CREATE TABLE delegation_triggers (
    trigger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delegation_id UUID NOT NULL REFERENCES delegations(delegation_id),
    type TEXT NOT NULL,
    config JSONB NOT NULL,
    enabled BOOLEAN DEFAULT true,
    last_fired_at TIMESTAMPTZ,
    fire_count INT DEFAULT 0
);
