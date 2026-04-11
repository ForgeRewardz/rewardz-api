/**
 * Blink publish route under `/v1/protocols/:id/blinks`.
 *
 * POST /v1/protocols/:id/blinks
 *   Body: {
 *     idlId: uuid,
 *     instructionName: string,
 *     classification: InstructionClassification,
 *     fixedAccounts: Record<string,string>,
 *     verificationAdapter: string,
 *     programId: string,
 *     mintOwners?: Record<string,"legacy"|"token-2022">,
 *     hints?: ClassificationHints,
 *   }
 *
 * Calls `blinksService.publishBlink` which enforces the adapter
 * allowlist and returns the runtime-ready BlinkManifest. Unknown
 * verification adapters 400 rather than 500 — the error message
 * from isKnownVerificationAdapter is descriptive enough to ship to
 * the console.
 *
 * Protected by requireBearerAuth + requireProtocolOwner. No public
 * endpoint — the public runtime routes live in blinks-runtime.ts.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type {
  ClassificationHints,
  FixedAccounts,
  InstructionClassification,
  MintOwnerMap,
} from "@rewardz/sdk/blinks";
import { requireBearerAuth, requireProtocolOwner } from "../middleware/auth.js";
import {
  getProgramProfile,
} from "../services/program-profile-service.js";
import {
  publishBlink,
} from "../services/blinks-service.js";

interface ProtocolParams {
  id: string;
}

interface PublishBlinkBody {
  idlId: string;
  instructionName: string;
  classification: InstructionClassification;
  fixedAccounts: FixedAccounts;
  verificationAdapter: string;
  programId: string;
  mintOwners?: MintOwnerMap;
  hints?: ClassificationHints;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

const protocolParamsSchema = z.object({
  id: z.string().min(1),
});

// Minimum-viable body shape check. Deep validation of
// classification / seeds / fixedAccounts happens inside the SDK's
// buildManifest; route-layer checks only enforce presence + types so
// malformed payloads 400 early instead of reaching the service.
const bucketValues = [
  "payer",
  "fixed",
  "user-pda",
  "user-ata",
  "user-input",
] as const;

const classificationSchema = z.object({
  accounts: z.record(z.string(), z.enum(bucketValues)),
  args: z.record(z.string(), z.enum(bucketValues)),
});

const publishBodySchema = z.object({
  idlId: z.string().uuid(),
  instructionName: z.string().min(1),
  classification: classificationSchema,
  fixedAccounts: z.record(z.string(), z.string()),
  verificationAdapter: z.string().min(1),
  programId: z.string().min(1),
  mintOwners: z
    .record(z.string(), z.enum(["legacy", "token-2022"]))
    .optional(),
  hints: z
    .object({
      accounts: z.record(z.string(), z.enum(bucketValues)).optional(),
      args: z.record(z.string(), z.enum(bucketValues)).optional(),
    })
    .optional(),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: "Bad Request", message });
}

function internalError(reply: FastifyReply, message: string) {
  return reply.status(500).send({ error: "Internal Server Error", message });
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function blinksPublishRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Params: ProtocolParams; Body: PublishBlinkBody }>(
    "/protocols/:id/blinks",
    {
      preHandler: [requireBearerAuth, requireProtocolOwner],
    },
    async (request, reply) => {
      const paramsParsed = protocolParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return badRequest(reply, "Invalid protocol id path parameter");
      }

      const bodyParsed = publishBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return badRequest(
          reply,
          `Invalid publish body: ${bodyParsed.error.message}`,
        );
      }

      const { id: protocolId } = paramsParsed.data;
      const body = bodyParsed.data;

      try {
        // Lazy-load the program profile because instructions with
        // zero user-pda accounts don't need one. If the caller
        // specifies a programId that doesn't have a stored profile,
        // we pass `undefined` and let buildManifest fail loudly only
        // when a user-pda account actually references a missing
        // template.
        const programProfile =
          (await getProgramProfile(protocolId, body.programId)) ?? undefined;

        const manifest = await publishBlink({
          protocolId,
          idlId: body.idlId,
          instructionName: body.instructionName,
          classification: body.classification,
          fixedAccounts: body.fixedAccounts,
          programProfile,
          verificationAdapter: body.verificationAdapter,
          mintOwners: body.mintOwners,
          hints: body.hints,
        });

        return reply.status(201).send(manifest);
      } catch (err) {
        request.log.error(err, "Failed to publish blink");
        const message = err instanceof Error ? err.message : String(err);
        // Adapter allowlist + sdk buildManifest invariants emit
        // descriptive errors; bubble them up as 400 rather than 500
        // so the console can render the reason inline.
        if (
          /unknown verification adapter|must have|not found|discriminator|seed|instruction/i.test(
            message,
          )
        ) {
          return badRequest(reply, message);
        }
        return internalError(reply, "Failed to publish blink");
      }
    },
  );
}

export default blinksPublishRoutes;
