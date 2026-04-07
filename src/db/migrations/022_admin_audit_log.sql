CREATE TABLE admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_wallet TEXT NOT NULL,
    action TEXT NOT NULL,
    target_protocol_id UUID,
    target_campaign_id UUID,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
