-- Migration 048 — Telemetry events sink.
--
-- Minimal fire-and-forget bucket for the mini-app telemetry emitter
-- (mini-app/src/features/telemetry/events.ts). Client POSTs events with
-- keepalive:true to `/v1/telemetry/events`; this table stores them for
-- later aggregation.
--
-- PII shape: `session_id` is a per-tab anonymous id minted in the client
-- (localStorage). No wallet addresses or tx signatures should land in the
-- payload. The payload is JSONB so we keep the client contract flexible
-- without bumping the schema every time a new event type lands.
--
-- Retention is out-of-scope for this migration — a later job can
-- DELETE FROM telemetry_events WHERE created_at < NOW() - INTERVAL '90 days'.

CREATE TABLE IF NOT EXISTS telemetry_events (
    id          BIGSERIAL       PRIMARY KEY,
    session_id  TEXT            NOT NULL,
    event_type  TEXT            NOT NULL,
    payload     JSONB           NOT NULL DEFAULT '{}'::jsonb,
    client_ts   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_type_created
    ON telemetry_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_created
    ON telemetry_events (session_id, created_at DESC);
