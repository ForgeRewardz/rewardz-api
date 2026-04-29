/**
 * IDL upload + program-profile routes under `/v1/protocols/:id/*`.
 *
 * Routes:
 *
 *   - POST /v1/protocols/:id/idls
 *     Body: raw IDL JSON (Anchor v0.1, Anchor v0.30+, or Codama root
 *     node). Body size capped at 2MB per Klaus R21.
 *
 *   - GET /v1/protocols/:id/idls/:idlId/instructions
 *     Returns the five-bucket classification preview for every
 *     instruction in the stored IDL.
 *
 *   - POST /v1/protocols/:id/program-profiles
 *     Body: { programId, seeds }. Seed DSL validation happens in
 *     programProfileService.upsertProgramProfile.
 *
 * Every route is protected by `requireBearerAuth + requireProtocolOwner`
 * so only the protocol's registered admin wallet can write. Error
 * handling mirrors the other routes (leaderboards.ts / campaigns.ts):
 * 400 for bad input, 404 for missing rows, 500 for unknown failures.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireBearerAuth, requireProtocolOwner } from "../middleware/auth.js";
import {
  getIdl,
  getInstructionPreview,
  listInstructions,
  uploadIdl,
} from "../services/idl-service.js";
import { upsertProgramProfile } from "../services/program-profile-service.js";

interface ProtocolParams {
  id: string;
}

interface IdlParams extends ProtocolParams {
  idlId: string;
}

interface ProgramProfileBody {
  programId: string;
  seeds: unknown;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Klaus R21: hard cap the raw IDL upload body at 2MB. */
const IDL_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const protocolParamsSchema = z.object({
  id: z.string().min(1),
});

const idlParamsSchema = z.object({
  id: z.string().min(1),
  idlId: z.string().uuid(),
});

// Seed DSL validation is handled end-to-end in the service — the
// route schema only enforces top-level shape so bad payloads still
// surface a 400 instead of hitting the service with a half-checked
// body.
const programProfileBodySchema = z.object({
  programId: z.string().min(1),
  // seeds is intentionally typed as `unknown` at the schema level —
  // the full five-source DSL validation lives in validateSeedDsl.
  seeds: z.unknown(),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "Bad Request", message });
}

function notFound(reply: FastifyReply, message: string) {
  return reply.status(404).send({ error: "Not Found", message });
}

function internalError(reply: FastifyReply, message: string) {
  return reply.status(500).send({ error: "Internal Server Error", message });
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function idlUploadRoutes(app: FastifyInstance): Promise<void> {
  /* ------ POST /protocols/:id/idls ------ */
  app.post<{ Params: ProtocolParams; Body: unknown }>(
    "/protocols/:id/idls",
    {
      bodyLimit: IDL_BODY_LIMIT_BYTES,
      preHandler: [requireBearerAuth, requireProtocolOwner],
    },
    async (request, reply) => {
      const paramsParsed = protocolParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return badRequest(reply, "Invalid protocol id path parameter");
      }

      const rawJson = request.body;
      if (rawJson === undefined || rawJson === null) {
        return badRequest(reply, "Request body must be a JSON IDL blob");
      }

      try {
        const result = await uploadIdl(paramsParsed.data.id, rawJson);
        return reply.status(201).send({
          idlId: result.idlId,
          idlHash: result.idlHash,
          instructions: result.instructions,
        });
      } catch (err) {
        request.log.error(err, "Failed to upload IDL");
        const message = err instanceof Error ? err.message : String(err);
        // normaliseIdl / parseIdl throw on unknown shapes — those are
        // 400-worthy, not 500. Use the error message to distinguish.
        if (/unknown|anchor|codama|invalid|parse/i.test(message)) {
          return badRequest(reply, `Failed to parse IDL: ${message}`);
        }
        return internalError(reply, "Failed to upload IDL");
      }
    },
  );

  /* ------ GET /protocols/:id/idls/:idlId/instructions ------
   *
   * Two response shapes on the same path, chosen by the presence of
   * the `instructionName` query param:
   *
   *   - No query param → bulk list for the wizard overview (every
   *     instruction with a best-effort classification or per-row error).
   *   - `?instructionName=foo` → rich single-instruction preview for
   *     the console's picker step: programId, account order, arg order,
   *     classification, account flags, arg type hints.
   *
   * Both are 200 on success. A missing instruction on the single-preview
   * branch surfaces as 404 — the list-endpoint does NOT emit 404 for an
   * instruction that classifies with errors; the error is part of the
   * per-row payload so the grid can still render the rest of the IDL.
   */
  app.get<{ Params: IdlParams; Querystring: { instructionName?: string } }>(
    "/protocols/:id/idls/:idlId/instructions",
    {
      preHandler: [requireBearerAuth, requireProtocolOwner],
    },
    async (request, reply) => {
      const paramsParsed = idlParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return badRequest(reply, "Invalid path parameters");
      }

      const { instructionName } = request.query;

      try {
        if (instructionName && instructionName.length > 0) {
          const preview = await getInstructionPreview(
            paramsParsed.data.id,
            paramsParsed.data.idlId,
            instructionName,
          );
          return reply.status(200).send(preview);
        }
        const result = await listInstructions(
          paramsParsed.data.id,
          paramsParsed.data.idlId,
        );
        return reply.status(200).send(result);
      } catch (err) {
        request.log.error(err, "Failed to list instructions");
        const message = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(message)) {
          return notFound(reply, message);
        }
        return internalError(reply, "Failed to list instructions");
      }
    },
  );

  /* ------ GET /protocols/:id/idls/:idlId (for console) ------ */
  app.get<{ Params: IdlParams }>(
    "/protocols/:id/idls/:idlId",
    {
      preHandler: [requireBearerAuth, requireProtocolOwner],
    },
    async (request, reply) => {
      const paramsParsed = idlParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return badRequest(reply, "Invalid path parameters");
      }

      try {
        const result = await getIdl(
          paramsParsed.data.id,
          paramsParsed.data.idlId,
        );
        return reply.status(200).send({
          idlId: paramsParsed.data.idlId,
          idlHash: result.hash,
          rawJson: result.rawJson,
          normalisedJson: result.normalisedJson,
        });
      } catch (err) {
        request.log.error(err, "Failed to fetch IDL");
        const message = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(message)) {
          return notFound(reply, "IDL not found for protocol");
        }
        return internalError(reply, "Failed to fetch IDL");
      }
    },
  );

  /* ------ POST /protocols/:id/program-profiles ------ */
  app.post<{ Params: ProtocolParams; Body: ProgramProfileBody }>(
    "/protocols/:id/program-profiles",
    {
      preHandler: [requireBearerAuth, requireProtocolOwner],
    },
    async (request, reply) => {
      const paramsParsed = protocolParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return badRequest(reply, "Invalid protocol id path parameter");
      }

      const bodyParsed = programProfileBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return badRequest(
          reply,
          `Invalid program-profile body: ${bodyParsed.error.message}`,
        );
      }

      try {
        const profile = await upsertProgramProfile(
          paramsParsed.data.id,
          bodyParsed.data.programId,
          bodyParsed.data.seeds,
        );
        return reply.status(200).send(profile);
      } catch (err) {
        request.log.error(err, "Failed to upsert program profile");
        const message = err instanceof Error ? err.message : String(err);
        // Seed DSL validation errors are 400-worthy.
        if (/seeds|kind|must be/i.test(message)) {
          return badRequest(reply, message);
        }
        return internalError(reply, "Failed to upsert program profile");
      }
    },
  );
}

export default idlUploadRoutes;
