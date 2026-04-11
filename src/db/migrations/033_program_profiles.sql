-- program_profiles stores the per-account seed templates the blink
-- compiler uses to derive PDAs at request time. One row per
-- (protocol, program_id) pair.
--
-- Authoritative DSL spec:
--   mobileSpecs/.claude/kernel-outlines/outline-plan-2026-04-11-phase5-v2.md §15G
--   ("Seed DSL for user-PDA accounts" / five-source DSL)
--
-- The seeds_jsonb structure is:
--   {
--     "<accountName>": [
--       { "kind": "literal",      "value": "stake"          },
--       { "kind": "payer"                                    },
--       { "kind": "scalar_arg",   "name": "amount"           },
--       { "kind": "account_ref",  "name": "tokenMint"        },
--       { "kind": "const_pubkey", "value": "<base58pubkey>"  }
--     ]
--   }
CREATE TABLE program_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    protocol_id UUID NOT NULL REFERENCES protocols(id),
    program_id TEXT NOT NULL,
    seeds_jsonb JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (protocol_id, program_id)
);
