CREATE TABLE quests (
    quest_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    quest_type TEXT NOT NULL,
    conditions JSONB NOT NULL,
    reward_points INTEGER NOT NULL,
    bonus_multiplier DECIMAL DEFAULT 1.0,
    composition_mode TEXT DEFAULT 'closed',
    created_by UUID REFERENCES protocols(id),
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    max_participants INTEGER,
    participant_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
