-- protocol_auth_sessions tracks nonces issued by /v1/auth/challenge and the
-- JWTs minted by /v1/auth/verify so the API can revoke them on logout.
-- Klaus R26: partial index on unconsumed nonces keeps the atomic
-- "consume once" UPDATE cheap even at high nonce store sizes.
CREATE TABLE protocol_auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nonce TEXT NOT NULL UNIQUE,
    wallet_address TEXT NOT NULL,
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    jwt_jti UUID,
    revoked_at TIMESTAMPTZ
);

-- Partial index for atomic nonce lookup during /v1/auth/verify. The
-- planned query is:
--   UPDATE protocol_auth_sessions
--      SET consumed_at = NOW()
--    WHERE nonce = $1 AND consumed_at IS NULL
-- RETURNING *;
-- so indexing only the NULL subset keeps it tiny.
CREATE UNIQUE INDEX idx_protocol_auth_sessions_nonce_unconsumed
    ON protocol_auth_sessions (nonce)
    WHERE consumed_at IS NULL;

-- Partial index for JWT revocation check in requireBearerAuth. Most rows
-- will be unrevoked so a partial index on the active subset stays small.
CREATE INDEX idx_protocol_auth_sessions_jti_active
    ON protocol_auth_sessions (jwt_jti)
    WHERE revoked_at IS NULL;
