CREATE TABLE quest_progress (
    quest_progress_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quest_id UUID NOT NULL REFERENCES quests(quest_id),
    user_wallet TEXT NOT NULL,
    conditions_met JSONB DEFAULT '[]',
    steps_completed INTEGER[] DEFAULT '{}',
    bonus_awarded BOOLEAN DEFAULT false,
    completed BOOLEAN DEFAULT false,
    completed_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(quest_id, user_wallet)
);
