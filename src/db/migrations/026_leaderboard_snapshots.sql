CREATE TABLE leaderboard_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id UUID REFERENCES leaderboard_seasons(id),
    type TEXT NOT NULL,
    rank INTEGER NOT NULL,
    entity_id TEXT NOT NULL,
    entity_name TEXT,
    total_points BIGINT NOT NULL,
    snapshot_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_leaderboard_snapshots_lookup ON leaderboard_snapshots(season_id, type, rank);
