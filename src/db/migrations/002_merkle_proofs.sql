CREATE TABLE merkle_proofs (
    id SERIAL PRIMARY KEY,
    epoch BIGINT NOT NULL,
    root TEXT NOT NULL,
    authority TEXT NOT NULL,
    proof BYTEA[] NOT NULL,
    amount BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_merkle_proofs_root_authority ON merkle_proofs(root, authority);
