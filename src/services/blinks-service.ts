/**
 * Blinks service for the §15G publish / runtime pipeline.
 *
 * Owns the `protocol_blinks` table (migration 034). Responsibilities:
 *
 *   - Publish: take a classified instruction from the console wizard,
 *     call the SDK's `buildManifest` to produce a runtime-ready
 *     {@link BlinkManifest}, resolve ATA mint-owner metadata (legacy
 *     SPL for MVP), and persist into `protocol_blinks.manifest_jsonb`.
 *   - Get: load a manifest by (protocolId, instructionSlug,
 *     fixedAccountsHash) so the public runtime routes can hydrate a
 *     transaction without any sdk calls.
 *   - List: sitemap feed for the public `/actions.json` route.
 *
 * Adapter gating: the publish path rejects any `verificationAdapter`
 * id that isn't in {@link KNOWN_VERIFICATION_ADAPTERS}. Hardcoding
 * the list at MVP is intentional — every new adapter needs both a
 * registry entry in `verifier.ts` and this allowlist update in the
 * same PR, which is the bounded surface the plan calls for.
 *
 * Authoritative spec: TODO-0015 §15G "API note — what api/ must add".
 */

import {
  type BlinkManifest,
  buildManifest,
  type ClassificationHints,
  classifyInstruction,
  type CodamaRootNode,
  type FixedAccounts,
  type MintOwnerMap,
  type ProgramProfile,
} from "@rewardz/sdk/blinks";
import { query } from "../db/client.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface PublishBlinkArgs {
  protocolId: string;
  idlId: string;
  instructionName: string;
  fixedAccounts: FixedAccounts;
  programProfile?: ProgramProfile;
  verificationAdapter: string;
  /**
   * Optional per-account override map. Keys are IDL account names for
   * user-ata accounts; values are the token program flavour. When
   * absent the publisher defaults to 'legacy' (SPL Token v1) per the
   * MVP cut — devnet RPC probing is explicitly out of scope.
   */
  mintOwners?: MintOwnerMap;
  /**
   * Classification hints passed to the SDK classifier. The publish
   * path re-runs the classifier server-side (not trusting the client)
   * so these hints are the admin's only lever for overriding default
   * bucket assignments.
   */
  hints?: ClassificationHints;
}

export interface ListedBlink {
  instructionSlug: string;
  fixedAccountsHash: string;
  instructionName: string;
  verificationAdapter: string;
}

/* -------------------------------------------------------------------------- */
/*  Adapter allowlist                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Known verification adapters. Every adapter listed here MUST have a
 * matching `registerAdapter` call in `services/verifier.ts` at module
 * load, otherwise the publish path will accept manifests the runtime
 * can't verify (404 at verification time — much worse debug
 * experience than a 400 at publish time).
 */
export const KNOWN_VERIFICATION_ADAPTERS = [
  "stake.steel.v1",
  "mint.steel.v1",
  "completion.generic.v1",
] as const;

export type KnownVerificationAdapter =
  (typeof KNOWN_VERIFICATION_ADAPTERS)[number];

/**
 * Returns true when `id` is one of the publish-accepted adapter ids.
 * Kept as a separate helper so the routes can reuse it to produce
 * friendly error bodies.
 */
export function isKnownVerificationAdapter(
  id: string,
): id is KnownVerificationAdapter {
  return (KNOWN_VERIFICATION_ADAPTERS as readonly string[]).includes(id);
}

/* -------------------------------------------------------------------------- */
/*  publishBlink                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Publish a new blink manifest. Pipeline:
 *
 *   1. Reject unknown verification adapters (400 at the route layer).
 *   2. Load the normalised Codama root from `protocol_idls`.
 *   3. Call SDK `buildManifest` to produce the runtime-ready manifest.
 *   4. Fill in mint-owner metadata for user-ata accounts. MVP default:
 *      legacy SPL for every ATA unless the caller supplied an override.
 *   5. Persist the manifest into `protocol_blinks` with the
 *      instruction slug + fixed-accounts hash as the natural key.
 *
 * The returned manifest includes the resolved mint-owner map so the
 * console wizard can confirm the publish in one round trip.
 */
export async function publishBlink(
  args: PublishBlinkArgs,
): Promise<BlinkManifest> {
  if (!isKnownVerificationAdapter(args.verificationAdapter)) {
    throw new Error(
      `Unknown verification adapter: ${args.verificationAdapter}. Allowed: ${KNOWN_VERIFICATION_ADAPTERS.join(", ")}`,
    );
  }

  // Load the normalised codama root so buildManifest has the source
  // of truth about discriminator layout and account/arg order.
  const idlRow = await query<{ normalised_json: CodamaRootNode }>(
    `SELECT normalised_json
       FROM protocol_idls
      WHERE id = $1 AND protocol_id = $2
      LIMIT 1`,
    [args.idlId, args.protocolId],
  );

  if (idlRow.rowCount === 0) {
    throw new Error("IDL not found for protocol");
  }

  const rootNode = idlRow.rows[0].normalised_json;

  // Re-run the classifier server-side so the multi-payer guard and
  // all other invariants fire on the ACTUAL IDL + hints, not on a
  // client-supplied classification that may have been hand-crafted.
  // The classifier is the single source of truth (Klaus B3).
  const classification = classifyInstruction(
    rootNode,
    args.instructionName,
    args.hints,
  );

  const manifest = buildManifest({
    rootNode,
    instructionName: args.instructionName,
    protocolId: args.protocolId,
    classification,
    fixedAccounts: args.fixedAccounts,
    programProfile: args.programProfile,
    verificationAdapter: args.verificationAdapter,
  });

  // Populate mintOwners for every user-ata account. The MVP default
  // is legacy SPL Token (v1). Admins who run Token-2022 mints must
  // supply an explicit override until the devnet smoke check lands.
  const ataAccountNames = Object.entries(manifest.classification.accounts)
    .filter(([, bucket]) => bucket === "user-ata")
    .map(([name]) => name);

  const mintOwners: MintOwnerMap = {};
  for (const accountName of ataAccountNames) {
    mintOwners[accountName] =
      args.mintOwners?.[accountName] ?? "legacy";
  }

  const finalManifest: BlinkManifest = {
    ...manifest,
    mintOwners,
  };

  // Persist. (protocol_id, instruction_slug, fixed_accounts_hash) is
  // unique so re-publishes of the same pin are idempotent via
  // ON CONFLICT DO UPDATE — the console can resubmit safely.
  await query(
    `INSERT INTO protocol_blinks (
       protocol_id, idl_id, instruction_name, instruction_slug,
       fixed_accounts_jsonb, fixed_accounts_hash, verification_adapter,
       mint_owner_by_account_jsonb, manifest_jsonb, status
     )
     VALUES (
       $1, $2, $3, $4,
       $5::jsonb, $6, $7,
       $8::jsonb, $9::jsonb, 'live'
     )
     ON CONFLICT (protocol_id, instruction_slug, fixed_accounts_hash)
     DO UPDATE SET
       idl_id = EXCLUDED.idl_id,
       instruction_name = EXCLUDED.instruction_name,
       fixed_accounts_jsonb = EXCLUDED.fixed_accounts_jsonb,
       verification_adapter = EXCLUDED.verification_adapter,
       mint_owner_by_account_jsonb = EXCLUDED.mint_owner_by_account_jsonb,
       manifest_jsonb = EXCLUDED.manifest_jsonb,
       status = 'live'`,
    [
      args.protocolId,
      args.idlId,
      finalManifest.instructionName,
      finalManifest.instructionSlug,
      JSON.stringify(finalManifest.fixedAccounts),
      finalManifest.fixedAccountsHash,
      finalManifest.verificationAdapter,
      ataAccountNames.length > 0 ? JSON.stringify(mintOwners) : null,
      JSON.stringify(finalManifest),
    ],
  );

  return finalManifest;
}

/* -------------------------------------------------------------------------- */
/*  getBlink                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Load a published blink manifest by its natural key. Returns `null`
 * when no row matches so the runtime routes can emit a 404 instead of
 * an opaque 500.
 *
 * `fixedAccountsHash` is optional for protocols that only pinned a
 * single variant of an instruction — routes that receive an undefined
 * hash should fall back to the single `live` row for that slug (and
 * 409 if there are multiple).
 */
export async function getBlink(
  protocolId: string,
  instructionSlug: string,
  fixedAccountsHash?: string,
): Promise<BlinkManifest | null> {
  if (fixedAccountsHash) {
    const result = await query<{ manifest_jsonb: BlinkManifest }>(
      `SELECT manifest_jsonb
         FROM protocol_blinks
        WHERE protocol_id = $1
          AND instruction_slug = $2
          AND fixed_accounts_hash = $3
          AND status = 'live'
        LIMIT 1`,
      [protocolId, instructionSlug, fixedAccountsHash],
    );
    if (result.rowCount === 0) return null;
    return result.rows[0].manifest_jsonb;
  }

  // No hash supplied: require exactly one live row for the slug. If
  // multiple pins exist, bail out so the caller can disambiguate.
  const result = await query<{ manifest_jsonb: BlinkManifest }>(
    `SELECT manifest_jsonb
       FROM protocol_blinks
      WHERE protocol_id = $1
        AND instruction_slug = $2
        AND status = 'live'
      ORDER BY created_at DESC
      LIMIT 2`,
    [protocolId, instructionSlug],
  );

  const count = result.rowCount ?? 0;
  if (count === 0) return null;
  if (count > 1) {
    throw new Error(
      `Multiple live blinks for ${instructionSlug}; provide fixedAccountsHash`,
    );
  }
  return result.rows[0].manifest_jsonb;
}

/* -------------------------------------------------------------------------- */
/*  listPublishedBlinks                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Enumerate every live blink, optionally scoped to a single protocol.
 * Used by the `/actions.json` sitemap aggregator. Returns the URL
 * slug parts plus the verification adapter id so the sitemap can
 * emit meaningful rules entries without re-reading the whole
 * manifest.
 */
export async function listPublishedBlinks(
  protocolId?: string,
): Promise<Array<ListedBlink & { protocolId: string }>> {
  if (protocolId) {
    const result = await query<{
      protocol_id: string;
      instruction_slug: string;
      fixed_accounts_hash: string;
      instruction_name: string;
      verification_adapter: string;
    }>(
      `SELECT protocol_id, instruction_slug, fixed_accounts_hash,
              instruction_name, verification_adapter
         FROM protocol_blinks
        WHERE protocol_id = $1 AND status = 'live'
        ORDER BY created_at ASC`,
      [protocolId],
    );
    return result.rows.map((r) => ({
      protocolId: r.protocol_id,
      instructionSlug: r.instruction_slug,
      fixedAccountsHash: r.fixed_accounts_hash,
      instructionName: r.instruction_name,
      verificationAdapter: r.verification_adapter,
    }));
  }

  const result = await query<{
    protocol_id: string;
    instruction_slug: string;
    fixed_accounts_hash: string;
    instruction_name: string;
    verification_adapter: string;
  }>(
    `SELECT protocol_id, instruction_slug, fixed_accounts_hash,
            instruction_name, verification_adapter
       FROM protocol_blinks
      WHERE status = 'live'
      ORDER BY protocol_id ASC, created_at ASC`,
  );
  return result.rows.map((r) => ({
    protocolId: r.protocol_id,
    instructionSlug: r.instruction_slug,
    fixedAccountsHash: r.fixed_accounts_hash,
    instructionName: r.instruction_name,
    verificationAdapter: r.verification_adapter,
  }));
}
