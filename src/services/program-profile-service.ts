/**
 * Program profile service for the §15G blinks pipeline.
 *
 * Owns the `program_profiles` table (migration 033). A "program
 * profile" is the admin-supplied seed template the blink builder uses
 * to derive PDAs at request time for any `user-pda` account of a
 * given program. One row per (protocol_id, program_id) pair.
 *
 * The seed DSL is a strict five-source allowlist:
 *
 *   - literal       — UTF-8 string bytes
 *   - payer         — 32-byte payer pubkey
 *   - scalar_arg    — little-endian bytes of an instruction arg
 *   - account_ref   — 32-byte pubkey of a sibling account
 *   - const_pubkey  — 32-byte hard-coded base58 pubkey
 *
 * The service validates every incoming seed against this allowlist
 * and rejects unknown `kind` values with a descriptive error. The
 * runtime derivation path (SDK) trusts the persisted shape, so any
 * drift would silently produce wrong PDAs — the gate is upstream here.
 *
 * Authoritative spec: TODO-0015 §15G "SDK note — five-source DSL".
 */

import type { PdaSeedTemplate, ProgramProfile } from "@rewardz/sdk/blinks";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

const ALLOWED_SEED_KINDS = [
  "literal",
  "payer",
  "scalar_arg",
  "account_ref",
  "const_pubkey",
] as const;

type AllowedSeedKind = (typeof ALLOWED_SEED_KINDS)[number];

function isAllowedSeedKind(kind: unknown): kind is AllowedSeedKind {
  return (
    typeof kind === "string" &&
    (ALLOWED_SEED_KINDS as readonly string[]).includes(kind)
  );
}

/**
 * Validate a seed DSL payload. Throws on unknown kinds, missing
 * required fields, or non-object / non-array shapes. Returns the
 * payload unchanged on success so callers can pipe it through.
 *
 * Shape contract (see migration 033 header comment):
 *
 *   {
 *     "<accountName>": {
 *       withBump?: boolean,
 *       seeds: SeedSource[]
 *     }
 *   }
 *
 * Each SeedSource must match one of the five allowlisted kinds plus
 * its required auxiliary fields:
 *
 *   literal       → { kind, value: string }
 *   payer         → { kind }
 *   scalar_arg    → { kind, name: string }
 *   account_ref   → { kind, name: string }
 *   const_pubkey  → { kind, value: string (base58) }
 */
export function validateSeedDsl(
  seeds: unknown,
): Record<string, PdaSeedTemplate> {
  if (typeof seeds !== "object" || seeds === null || Array.isArray(seeds)) {
    throw new Error("seeds must be an object keyed by account name");
  }

  const result: Record<string, PdaSeedTemplate> = {};

  for (const [accountName, template] of Object.entries(
    seeds as Record<string, unknown>,
  )) {
    if (
      typeof template !== "object" ||
      template === null ||
      Array.isArray(template)
    ) {
      throw new Error(`seeds.${accountName} must be an object`);
    }

    const t = template as Record<string, unknown>;

    if (!Array.isArray(t.seeds)) {
      throw new Error(`seeds.${accountName}.seeds must be an array`);
    }

    const validatedSeeds = t.seeds.map((seed, i) => {
      if (typeof seed !== "object" || seed === null || Array.isArray(seed)) {
        throw new Error(
          `seeds.${accountName}.seeds[${i}] must be a SeedSource object`,
        );
      }
      const s = seed as Record<string, unknown>;

      if (!isAllowedSeedKind(s.kind)) {
        throw new Error(
          `seeds.${accountName}.seeds[${i}].kind must be one of ${ALLOWED_SEED_KINDS.join(", ")} (got ${JSON.stringify(s.kind)})`,
        );
      }

      switch (s.kind) {
        case "literal":
          if (typeof s.value !== "string") {
            throw new Error(
              `seeds.${accountName}.seeds[${i}] literal requires string value`,
            );
          }
          return { kind: "literal" as const, value: s.value };
        case "payer":
          return { kind: "payer" as const };
        case "scalar_arg":
          if (typeof s.name !== "string" || s.name.length === 0) {
            throw new Error(
              `seeds.${accountName}.seeds[${i}] scalar_arg requires non-empty string name`,
            );
          }
          return { kind: "scalar_arg" as const, name: s.name };
        case "account_ref":
          if (typeof s.name !== "string" || s.name.length === 0) {
            throw new Error(
              `seeds.${accountName}.seeds[${i}] account_ref requires non-empty string name`,
            );
          }
          return { kind: "account_ref" as const, name: s.name };
        case "const_pubkey":
          if (typeof s.value !== "string" || s.value.length === 0) {
            throw new Error(
              `seeds.${accountName}.seeds[${i}] const_pubkey requires non-empty base58 string value`,
            );
          }
          return { kind: "const_pubkey" as const, value: s.value };
      }
    });

    const validatedTemplate: PdaSeedTemplate = {
      seeds: validatedSeeds,
    };
    if (typeof t.withBump === "boolean") {
      validatedTemplate.withBump = t.withBump;
    }

    result[accountName] = validatedTemplate;
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  upsertProgramProfile                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Upsert a program profile for (protocolId, programId). Validates
 * the seed DSL before touching the DB so a bad payload never lands
 * in `seeds_jsonb`. The UNIQUE (protocol_id, program_id) constraint
 * backs the ON CONFLICT clause.
 */
export async function upsertProgramProfile(
  protocolId: string,
  programId: string,
  seeds: unknown,
): Promise<ProgramProfile> {
  const validated = validateSeedDsl(seeds);

  await query(
    `INSERT INTO program_profiles (protocol_id, program_id, seeds_jsonb)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (protocol_id, program_id)
     DO UPDATE SET
       seeds_jsonb = EXCLUDED.seeds_jsonb,
       updated_at = NOW()`,
    [protocolId, programId, JSON.stringify(validated)],
  );

  return {
    programId,
    seeds: validated,
  };
}

/* -------------------------------------------------------------------------- */
/*  getProgramProfile                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Load a program profile by (protocolId, programId). Returns null
 * when no row matches — callers (publish flow) should treat this as
 * "no PDAs to derive for this program, proceed if the instruction
 * has zero user-pda accounts, fail otherwise".
 */
export async function getProgramProfile(
  protocolId: string,
  programId: string,
): Promise<ProgramProfile | null> {
  const result = await query<{
    program_id: string;
    seeds_jsonb: Record<string, PdaSeedTemplate>;
  }>(
    `SELECT program_id, seeds_jsonb
       FROM program_profiles
      WHERE protocol_id = $1 AND program_id = $2
      LIMIT 1`,
    [protocolId, programId],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  return {
    programId: row.program_id,
    seeds: row.seeds_jsonb,
  };
}
