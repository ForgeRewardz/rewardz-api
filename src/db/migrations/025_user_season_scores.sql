CREATE TABLE user_season_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id UUID REFERENCES leaderboard_seasons(id),
    user_wallet TEXT NOT NULL,
    total_points BIGINT DEFAULT 0,
    tweet_points BIGINT DEFAULT 0,
    api_points BIGINT DEFAULT 0,
    webhook_points BIGINT DEFAULT 0,
    blink_points BIGINT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(season_id, user_wallet)
);
CREATE INDEX idx_user_season_scores_rank ON user_season_scores(season_id, total_points DESC);
