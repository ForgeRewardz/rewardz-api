CREATE TABLE tweet_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_wallet TEXT NOT NULL,
    protocol_id UUID REFERENCES protocols(id),
    rule_id UUID REFERENCES tweet_verification_rules(id),
    tweet_url TEXT NOT NULL,
    tweet_id TEXT NOT NULL,
    points_awarded INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tweet_id, user_wallet)
);
