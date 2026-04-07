CREATE TABLE protocol_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id UUID REFERENCES leaderboard_seasons(id),
    protocol_id UUID REFERENCES protocols(id),
    total_points_issued BIGINT DEFAULT 0,
    tweet_points BIGINT DEFAULT 0,
    api_points BIGINT DEFAULT 0,
    webhook_points BIGINT DEFAULT 0,
    blink_points BIGINT DEFAULT 0,
    unique_users_rewarded INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(season_id, protocol_id)
);
CREATE INDEX idx_protocol_scores_rank ON protocol_scores(season_id, total_points_issued DESC);
