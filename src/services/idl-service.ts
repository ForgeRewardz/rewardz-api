/**
 * IDL service for the §15G blinks pipeline.
 *
 * Owns the `protocol_idls` table (migration 032) and the boundary
 * between raw admin uploads and the canonical Codama root nodes that
 * the SDK's classifier / builder consume. Drift detection on
 * re-upload is explicitly OUT of scope for MVP — the upload function
 * inserts a new row every time and lets the caller pick the most
 * recent one.
 *
 * Authoritative spec: TODO-0015 §15G "API note — what api/ must add".
 */

import {
  classifyInstruction,
  type ClassificationHints,
  type CodamaRootNode,
  type InstructionClassification,
  normaliseIdl,
} from "@rewardz/sdk/blinks";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface UploadIdlResult {
  idlId: string;
  idlHash: string;
  /** List of instruction names extracted from the normalised root. */
  instructions: string[];
}

export interface InstructionPreview {
  name: string;
  /**
   * Classification buckets produced by the SDK classifier. Omitted when
   * the classifier could not bucket the instruction (ambiguous or
   * unrecognised shape); in that case `error` carries the reason so the
   * console can render a per-row banner without special-casing a magic
   * key on the classification object itself.
   */
  classification?: InstructionClassification;
  /** Populated iff classification could not be computed. */
  error?: string;
}

export interface ListInstructionsResult {
  instructions: InstructionPreview[];
}

export interface GetIdlResult {
  rawJson: unknown;
  normalisedJson: CodamaRootNode;
  hash: string;
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Walk the Codama root node's first program and return its instruction
 * names in IDL order. The SDK guarantees `rootNode.program.instructions`
 * is present after `normaliseIdl`, but we defensively probe both the
 * v1 (single `program`) and v2 (`programs[0]`) shapes the codama
 * upstream publishes so we don't break if the library rev bumps.
 */
function extractInstructionNames(root: CodamaRootNode): string[] {
  const rootRecord = root as unknown as Record<string, unknown>;

  const programs = rootRecord.programs as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(programs) && programs.length > 0) {
    const ixs = programs[0].instructions as
      | Array<{ name?: string }>
      | undefined;
    if (Array.isArray(ixs)) {
      return ixs.map((ix) => String(ix.name ?? "")).filter((n) => n.length > 0);
    }
  }

  const program = rootRecord.program as Record<string, unknown> | undefined;
  if (program && Array.isArray(program.instructions)) {
    const ixs = program.instructions as Array<{ name?: string }>;
    return ixs.map((ix) => String(ix.name ?? "")).filter((n) => n.length > 0);
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Upload a raw Anchor/Codama IDL JSON blob, normalise it, and persist
 * into `protocol_idls`. Returns the new row id, stable idl hash, and
 * the list of instruction names so the console can render a picker
 * immediately without a follow-up round trip.
 *
 * Drift detection is explicitly disabled for MVP — re-uploading the
 * same IDL produces a new row. The table has a composite index on
 * `(protocol_id, idl_hash)` for future drift queries.
 */
export async function uploadIdl(
  protocolId: string,
  rawJson: unknown,
): Promise<UploadIdlResult> {
  // normaliseIdl throws on malformed input; let the route translate to 400.
  const { node, hash } = normaliseIdl(rawJson);

  const rawText = JSON.stringify(rawJson);

  const result = await query<{ id: string }>(
    `INSERT INTO protocol_idls (protocol_id, raw_json, normalised_json, idl_hash)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id`,
    [protocolId, rawText, JSON.stringify(node), hash],
  );

  const idlId = result.rows[0].id;

  return {
    idlId,
    idlHash: hash,
    instructions: extractInstructionNames(node),
  };
}

/**
 * List every instruction in a stored IDL along with its classifier
 * preview. Used by the console's IDL wizard to render the
 * account/arg buckets before the admin publishes a blink.
 *
 * Throws if the idl row does not belong to the supplied protocol.
 */
export async function listInstructions(
  protocolId: string,
  idlId: string,
  hints?: Record<string, ClassificationHints>,
): Promise<ListInstructionsResult> {
  const result = await query<{ normalised_json: CodamaRootNode }>(
    `SELECT normalised_json
       FROM protocol_idls
      WHERE id = $1 AND protocol_id = $2
      LIMIT 1`,
    [idlId, protocolId],
  );

  if (result.rowCount === 0) {
    throw new Error("IDL not found for protocol");
  }

  const root = result.rows[0].normalised_json;
  const names = extractInstructionNames(root);

  const instructions: InstructionPreview[] = [];
  for (const name of names) {
    try {
      const classification = classifyInstruction(root, name, hints?.[name]);
      instructions.push({ name, classification });
    } catch (err) {
      // Ambiguous-classifier errors surface per-instruction so the
      // admin can break the tie via hints without losing the rest of
      // the preview. Emit an explicit `error` field rather than a
      // synthetic classification so the console can show a row-level
      // banner without probing a magic key.
      const reason = err instanceof Error ? err.message : String(err);
      instructions.push({ name, error: reason });
    }
  }

  return { instructions };
}

/**
 * Load a stored IDL row by id. Throws if the row does not belong to
 * the supplied protocol so callers can't read across tenants by
 * brute-forcing idl uuids.
 */
export async function getIdl(
  protocolId: string,
  idlId: string,
): Promise<GetIdlResult> {
  const result = await query<{
    raw_json: string;
    normalised_json: CodamaRootNode;
    idl_hash: string;
  }>(
    `SELECT raw_json, normalised_json, idl_hash
       FROM protocol_idls
      WHERE id = $1 AND protocol_id = $2
      LIMIT 1`,
    [idlId, protocolId],
  );

  if (result.rowCount === 0) {
    throw new Error("IDL not found for protocol");
  }

  const row = result.rows[0];
  return {
    rawJson: JSON.parse(row.raw_json),
    normalisedJson: row.normalised_json,
    hash: row.idl_hash,
  };
}
