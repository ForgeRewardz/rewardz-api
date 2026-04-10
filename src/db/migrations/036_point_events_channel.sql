-- Klaus A6: stop overloading source.type to mean channel. Add an
-- explicit `channel` column with a CHECK constraint so downstream
-- breakdown queries can filter by the ingestion surface (api, webhook,
-- blink, completion, tweet).
--
-- Backfill heuristic:
--   * rows with a non-null source_signature came from the completions
--     flow (on-chain signature submitted via POST /v1/completions) so we
--     tag them 'completion'. Note that blink-originated awards also land
--     via the completions flow today, so they're folded into 'completion'
--     for the backfill — future code paths that mint directly via a
--     blink route will set channel='blink' on insert.
--   * all other rows default to 'api' (console / internal API).
ALTER TABLE point_events
    ADD COLUMN channel TEXT NOT NULL DEFAULT 'api'
        CHECK (channel IN ('api', 'webhook', 'blink', 'completion', 'tweet'));

UPDATE point_events
   SET channel = 'completion'
 WHERE source_signature IS NOT NULL;

CREATE INDEX idx_point_events_channel_created
    ON point_events (channel, created_at DESC);
