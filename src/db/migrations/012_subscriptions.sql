CREATE TABLE subscriptions (
    subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL,
    quest_id UUID REFERENCES quests(quest_id),
    action_type TEXT NOT NULL,
    intent_query TEXT,
    params JSONB NOT NULL DEFAULT '{}',
    frequency TEXT NOT NULL,
    preferred_day INTEGER,
    preferred_hour INTEGER DEFAULT 10,
    auto_execute BOOLEAN DEFAULT false,
    streak_current INTEGER DEFAULT 0,
    streak_longest INTEGER DEFAULT 0,
    multiplier DECIMAL DEFAULT 1.0,
    last_executed_at TIMESTAMPTZ,
    next_due_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_wallet ON subscriptions(wallet_address);
CREATE INDEX idx_subscriptions_due ON subscriptions(next_due_at) WHERE status = 'active';
