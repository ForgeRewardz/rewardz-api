CREATE TABLE protocols (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_wallet TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    blink_base_url TEXT,
    supported_actions TEXT[] DEFAULT '{}',
    trust_score INTEGER DEFAULT 5000,
    status TEXT DEFAULT 'pending',
    api_key_hash TEXT,
    valid_completion_ratio DECIMAL DEFAULT 1.0,
    dispute_rate DECIMAL DEFAULT 0.0,
    fraud_rate DECIMAL DEFAULT 0.0,
    quality_score DECIMAL DEFAULT 0.5,
    callback_reliability DECIMAL DEFAULT 1.0,
    verification_failure_rate DECIMAL DEFAULT 0.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
