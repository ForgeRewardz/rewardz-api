/**
 * Public runtime routes for published blinks.
 *
 * This module owns the three HTTP methods that dial.to (and any other
 * Solana Actions client) hits at request time:
 *
 *   - GET  /v1/blinks/:protocolId/:instructionSlug/:fixedAccountsHash?
 *     Returns an ActionGetResponse — the manifest-driven label, title,
 *     description, and the parameters[] array synthesised from the
 *     user-input args in the stored manifest.
 *
 *   - POST /v1/blinks/:protocolId/:instructionSlug/:fixedAccountsHash?
 *     Added in 75b — assembles a VersionedTransaction.
 *
 *   - OPTIONS /v1/blinks/... — preflight handler added in 75c.
 *
 * None of these routes require authentication. The CORS headers come
 * from the corsActionsPlugin onRequest hook registered globally.
 *
 * Authoritative spec: TODO-0015 §15G "API note — what api/ must add".
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BlinkManifest } from "@rewardz/sdk/blinks";
import { getBlink } from "../services/blinks-service.js";
import { applyActionsCorsHeaders } from "../middleware/cors-actions.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface BlinkRouteParams {
  protocolId: string;
  instructionSlug: string;
  fixedAccountsHash?: string;
}

interface ActionGetResponseParameter {
  name: string;
  label: string;
  required: boolean;
}

interface ActionGetResponseLink {
  label: string;
  href: string;
  parameters?: ActionGetResponseParameter[];
}

interface ActionGetResponse {
  icon: string;
  label: string;
  title: string;
  description: string;
  links?: {
    actions: ActionGetResponseLink[];
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a human-readable title from an IDL instruction name. The
 * stored manifest.instructionName is camelCase (from the IDL); this
 * helper splits on case boundaries and title-cases the words.
 */
function humaniseInstructionName(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Render the `parameters[]` array for an ActionGetResponse from the
 * manifest's argLayout. Every arg that the classification marks as
 * `user-input` becomes a required parameter. Arg labels reuse the
 * humanised arg name.
 */
function parametersFromManifest(
  manifest: BlinkManifest,
): ActionGetResponseParameter[] {
  const params: ActionGetResponseParameter[] = [];
  for (const arg of manifest.argLayout) {
    const bucket = manifest.classification.args[arg.name];
    if (bucket === "user-input") {
      params.push({
        name: arg.name,
        label: humaniseInstructionName(arg.name),
        required: true,
      });
    }
  }
  return params;
}

/**
 * Build a query-parameter suffix for the Action href from the
 * parameter list. dial.to substitutes `{name}` placeholders with
 * user input before POSTing, so the href must include them
 * verbatim.
 */
function buildHrefQueryTemplate(
  params: ActionGetResponseParameter[],
): string {
  if (params.length === 0) return "";
  const pairs = params.map((p) => `${p.name}={${p.name}}`);
  return `?${pairs.join("&")}`;
}

/**
 * Send a JSON error payload with the CORS headers attached. The
 * global onRequest hook sets these too, but we re-apply defensively
 * because the hook runs before the body is serialised and a late
 * header mutation can sometimes be dropped by Fastify's reply lifecycle.
 */
function sendActionError(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  applyActionsCorsHeaders(reply);
  return reply.status(status).send({ error: message });
}

/**
 * Load the manifest for a runtime request, handling the two
 * "missing hash" disambiguation cases with structured errors.
 *
 * Returns null on true 404, throws on 409 (multiple live pins), and
 * returns the manifest on success.
 */
async function loadManifestOr404(
  params: BlinkRouteParams,
): Promise<BlinkManifest | null> {
  return getBlink(
    params.protocolId,
    params.instructionSlug,
    params.fixedAccountsHash,
  );
}

/* -------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* -------------------------------------------------------------------------- */

export async function blinksRuntimeRoutes(
  app: FastifyInstance,
): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /*  GET (75a): ActionGetResponse                                          */
  /* ---------------------------------------------------------------------- */

  const getHandler = async (
    request: FastifyRequest<{ Params: BlinkRouteParams }>,
    reply: FastifyReply,
  ) => {
    try {
      const manifest = await loadManifestOr404(request.params);
      if (!manifest) {
        return sendActionError(reply, 404, "Blink not found");
      }

      const params = parametersFromManifest(manifest);
      const basePath = request.params.fixedAccountsHash
        ? `/v1/blinks/${request.params.protocolId}/${request.params.instructionSlug}/${request.params.fixedAccountsHash}`
        : `/v1/blinks/${request.params.protocolId}/${request.params.instructionSlug}`;

      const humanName = humaniseInstructionName(manifest.instructionName);

      const response: ActionGetResponse = {
        // MVP placeholder: the console wizard will publish a protocol
        // logo URL alongside the manifest in a future session. For
        // now dial.to falls back to a default icon when this path is
        // a 404.
        icon: "https://rewardz.fun/icon.png",
        label: humanName,
        title: `${humanName} with REWARDZ`,
        description: `Execute the ${manifest.instructionName} instruction on program ${manifest.programId}.`,
        links: {
          actions: [
            {
              label: "Submit",
              href: `${basePath}${buildHrefQueryTemplate(params)}`,
              parameters: params,
            },
          ],
        },
      };

      applyActionsCorsHeaders(reply);
      return reply.status(200).send(response);
    } catch (err) {
      request.log.error(err, "blinks-runtime GET failed");
      const message = err instanceof Error ? err.message : String(err);
      if (/multiple live/i.test(message)) {
        return sendActionError(reply, 409, message);
      }
      return sendActionError(reply, 500, "Failed to load blink");
    }
  };

  app.get<{ Params: BlinkRouteParams }>(
    "/blinks/:protocolId/:instructionSlug/:fixedAccountsHash",
    getHandler,
  );
  app.get<{ Params: BlinkRouteParams }>(
    "/blinks/:protocolId/:instructionSlug",
    getHandler,
  );
}

export default blinksRuntimeRoutes;
