CREATE TABLE tweet_verification_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID REFERENCES protocols(id),
    label TEXT NOT NULL,
    base_points INTEGER NOT NULL DEFAULT 0,
    bonus_per_like INTEGER DEFAULT 0,
    bonus_per_retweet INTEGER DEFAULT 0,
    required_handles TEXT[] DEFAULT '{}',
    required_hashtags TEXT[] DEFAULT '{}',
    required_cashtags TEXT[] DEFAULT '{}',
    all_required BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    max_submissions_per_wallet INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
