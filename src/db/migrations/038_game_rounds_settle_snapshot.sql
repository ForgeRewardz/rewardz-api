-- F3 three-step refactor surface on game_rounds.
--
-- `settle_round` now emits a snapshot payload instead of per-player results.
-- Capture the five snapshot fields so the off-chain listener can synthesize
-- player outcomes (computePlayerHit + reward formula in game-service.ts) and
-- the /v1/game/round/:id/status endpoint can surface the refund-mode branch.
--
-- `slot_hash` is not carried in the RoundSettled log — the keeper fetches
-- it from the GameRound account and persists it here so the API can answer
-- /v1/game/round/:id/results without extra RPC traffic.

ALTER TABLE game_rounds
    ADD COLUMN IF NOT EXISTS settle_timestamp BIGINT,
    ADD COLUMN IF NOT EXISTS expires_at BIGINT,
    ADD COLUMN IF NOT EXISTS refund_mode BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS total_points_deployed BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS slot_hash BYTEA;

ALTER TABLE player_deployments
    ADD COLUMN IF NOT EXISTS checkpointed BOOLEAN NOT NULL DEFAULT false;
