CREATE TABLE quest_steps (
    id SERIAL PRIMARY KEY,
    quest_id UUID NOT NULL REFERENCES quests(quest_id),
    step_index INTEGER NOT NULL,
    intent_type TEXT NOT NULL,
    protocol_id UUID REFERENCES protocols(id),
    params JSONB NOT NULL DEFAULT '{}',
    reward_policy_id UUID REFERENCES reward_policies(id),
    points INTEGER DEFAULT 0,
    depends_on INTEGER,
    UNIQUE(quest_id, step_index)
);
