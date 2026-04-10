-- protocol_idls stores uploaded Anchor/Codama IDLs for each protocol.
-- Klaus R22: raw_json is TEXT (cheap storage for unused blobs) and only
-- normalised_json is JSONB so queries operate on the normalised form.
CREATE TABLE protocol_idls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID NOT NULL REFERENCES protocols(id),
    raw_json TEXT NOT NULL,
    normalised_json JSONB NOT NULL,
    idl_hash TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drift detection on re-upload: look up by (protocol_id, idl_hash) to
-- detect whether the incoming upload is identical to a prior revision.
CREATE INDEX idx_protocol_idls_protocol_hash
    ON protocol_idls (protocol_id, idl_hash);

-- Most-recent-upload lookup for the console's "current IDL" view.
CREATE INDEX idx_protocol_idls_protocol_uploaded
    ON protocol_idls (protocol_id, uploaded_at DESC);
