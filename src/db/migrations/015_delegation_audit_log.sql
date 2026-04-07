CREATE TABLE delegation_audit_log (
    id SERIAL PRIMARY KEY,
    delegation_id UUID NOT NULL REFERENCES delegations(delegation_id),
    trigger_id UUID,
    action TEXT NOT NULL,
    tx_signature TEXT,
    result JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
