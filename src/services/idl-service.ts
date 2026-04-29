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

/**
 * Rich single-instruction preview returned when the list endpoint is
 * called with a specific `instructionName` query param. The console's
 * picker step consumes this directly — it carries the IDL-declared
 * account and argument ordering (which the bucket grid renders
 * row-by-row) plus the program id so the downstream program-profile
 * editor knows which `(protocol, program)` tuple to key off.
 */
export interface InstructionPreviewRich {
  instructionName: string;
  programId: string;
  accountOrder: string[];
  argOrder: string[];
  classification: InstructionClassification;
  accountFlags: Record<string, { isSigner: boolean; isWritable: boolean }>;
  argTypes: Record<string, string>;
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
 * Return the rich single-instruction preview the console picker step
 * needs. This is the `instructionName=...` branch of the list endpoint
 * — `listInstructions` keeps the bulk shape for callers that want
 * every instruction at once.
 *
 * Looks up the stored IDL row, finds the named instruction in either
 * `program.instructions` or any `additionalPrograms[*].instructions`,
 * and pulls:
 *
 *   - programId from the owning program node (`publicKey`)
 *   - accountOrder from the instruction's account list (IDL order, so
 *     the bucket grid rows line up with the on-chain account meta
 *     order consumed by buildInstruction)
 *   - argOrder from the instruction's argument list
 *   - classification via the SDK's classifyInstruction
 *   - accountFlags (isSigner / isWritable) for the bucket grid tooltip
 *   - argTypes (scalar name) for the publish-step input form
 */
export async function getInstructionPreview(
  protocolId: string,
  idlId: string,
  instructionName: string,
): Promise<InstructionPreviewRich> {
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

  const root = result.rows[0].normalised_json as unknown as Record<
    string,
    unknown
  >;

  interface IxAccount {
    name: string;
    isSigner?: boolean | "either";
    isWritable?: boolean;
  }
  interface IxArg {
    name: string;
    type?: { kind?: string; format?: string };
  }
  interface IxNode {
    name: string;
    accounts: IxAccount[];
    arguments: IxArg[];
  }
  interface ProgNode {
    publicKey?: string;
    instructions: IxNode[];
  }

  // Probe v1 (`program`) and v2 (`programs[0]`) Codama shapes — mirrors
  // the defensive `extractInstructionNames` helper above.
  const candidates: ProgNode[] = [];
  const v2Programs = root.programs as ProgNode[] | undefined;
  if (Array.isArray(v2Programs)) candidates.push(...v2Programs);
  const v1Program = root.program as ProgNode | undefined;
  if (v1Program && !Array.isArray(v2Programs)) candidates.push(v1Program);
  const extras = root.additionalPrograms as ProgNode[] | undefined;
  if (Array.isArray(extras)) candidates.push(...extras);

  let matchedProgram: ProgNode | null = null;
  let matchedIx: IxNode | null = null;
  for (const prog of candidates) {
    const ix = prog.instructions?.find((i) => i.name === instructionName);
    if (ix) {
      matchedProgram = prog;
      matchedIx = ix;
      break;
    }
  }

  if (!matchedProgram || !matchedIx) {
    throw new Error(`Instruction '${instructionName}' not found in IDL`);
  }

  const accountOrder = matchedIx.accounts.map((a) => a.name);
  const argOrder = matchedIx.arguments.map((a) => a.name);

  const accountFlags: Record<
    string,
    { isSigner: boolean; isWritable: boolean }
  > = {};
  for (const account of matchedIx.accounts) {
    accountFlags[account.name] = {
      isSigner: account.isSigner === true || account.isSigner === "either",
      isWritable: account.isWritable === true,
    };
  }

  const argTypes: Record<string, string> = {};
  for (const arg of matchedIx.arguments) {
    const t = arg.type;
    if (t && typeof t === "object") {
      if (t.format) argTypes[arg.name] = t.format;
      else if (t.kind) argTypes[arg.name] = t.kind;
    }
  }

  // classifyInstruction expects the full CodamaRootNode, so cast back.
  const classification = classifyInstruction(
    root as unknown as CodamaRootNode,
    instructionName,
  );

  return {
    instructionName,
    programId: matchedProgram.publicKey ?? "",
    accountOrder,
    argOrder,
    classification,
    accountFlags,
    argTypes,
  };
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
