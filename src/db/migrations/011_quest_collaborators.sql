CREATE TABLE quest_collaborators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quest_id UUID NOT NULL REFERENCES quests(quest_id),
    protocol_id UUID NOT NULL REFERENCES protocols(id),
    role TEXT NOT NULL DEFAULT 'step_provider',
    reward_policy_id UUID REFERENCES reward_policies(id),
    step_index INTEGER,
    status TEXT DEFAULT 'invited',
    joined_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX unique_quest_collaborator_step ON quest_collaborators(quest_id, protocol_id, step_index) WHERE step_index IS NOT NULL;
CREATE UNIQUE INDEX unique_quest_collaborator_quest ON quest_collaborators(quest_id, protocol_id) WHERE step_index IS NULL;
