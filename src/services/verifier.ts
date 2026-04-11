import { Connection, PublicKey } from "@solana/web3.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Legacy result shape kept for existing callers that predate the
 * adapter-dispatch refactor. Mirrors `VerificationResult` but stays
 * boolean-style so `routes/completions.ts` can keep reading
 * `verification.verified` without churn.
 */
export interface LegacyVerificationResult {
  verified: boolean;
  reason?: string;
}

/**
 * Rich result emitted by every {@link VerificationAdapter}. `amount`
 * surfaces for stake-like adapters that need to cross-check eligibility
 * gates; `meta` carries adapter-specific debug data for audit logs.
 */
export type VerificationResult =
  | { ok: true; amount?: bigint; meta?: Record<string, unknown> }
  | { ok: false; reason: string };

export interface VerifyArgs {
  signature: string;
  expectedWallet: string;
  expectedReference?: string;
  rpcUrl: string;
}

/**
 * Canonical adapter shape. Each adapter is responsible for fetching
 * the tx, running its own decode / assertion, and emitting a
 * structured `VerificationResult`. Adapter ids MUST mirror the
 * `KNOWN_VERIFICATION_ADAPTERS` allowlist in blinks-service.
 */
export interface VerificationAdapter {
  id: string;
  verify(args: VerifyArgs): Promise<VerificationResult>;
}

/* -------------------------------------------------------------------------- */
/*  Registry                                                                  */
/* -------------------------------------------------------------------------- */

const ADAPTERS = new Map<string, VerificationAdapter>();

/**
 * Register a verification adapter at module load. Safe to call
 * multiple times — the last registration wins for a given id, which
 * matches the "reload on test rebuild" lifecycle the test harness
 * depends on.
 */
export function registerAdapter(adapter: VerificationAdapter): void {
  ADAPTERS.set(adapter.id, adapter);
}

/**
 * Look up an adapter by id without throwing. Returns null when no
 * adapter matches so callers can translate to a 404 / 400.
 */
export function getAdapter(id: string): VerificationAdapter | null {
  return ADAPTERS.get(id) ?? null;
}

/**
 * List every registered adapter id. Used by health-check routes and
 * tests to assert the registry is fully wired at boot.
 */
export function listAdapters(): string[] {
  return Array.from(ADAPTERS.keys());
}

/**
 * Dispatch a verification request to the named adapter. Throws if
 * the adapter is unknown — routes should translate into 400.
 */
export async function dispatchVerification(
  adapterId: string,
  args: VerifyArgs,
): Promise<VerificationResult> {
  const adapter = ADAPTERS.get(adapterId);
  if (!adapter) {
    throw new Error(
      `Unknown verification adapter: ${adapterId}. Registered: ${listAdapters().join(", ")}`,
    );
  }
  return adapter.verify(args);
}

/* -------------------------------------------------------------------------- */
/*  completion.generic.v1 — default adapter (legacy generic verifier)         */
/* -------------------------------------------------------------------------- */

/**
 * Verify that an on-chain transaction meets the expected criteria.
 *
 * Checks:
 * 1. Transaction exists and is confirmed
 * 2. The expected wallet is among the signers
 * 3. The expected reference string appears in instruction data or memo
 *
 * Preserved as a named export so existing call sites (pre-refactor)
 * keep working. New callers should go through
 * `dispatchVerification("completion.generic.v1", ...)`.
 */
export async function verifyCompletion(
  signature: string,
  expectedWallet: string,
  expectedReference: string,
  rpcUrl: string,
): Promise<LegacyVerificationResult> {
  const connection = new Connection(rpcUrl, "confirmed");

  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return { verified: false, reason: "Transaction not found" };
    }

    if (tx.meta?.err) {
      return {
        verified: false,
        reason: `Transaction failed: ${JSON.stringify(tx.meta.err)}`,
      };
    }

    // --- Verify signer ---
    const accountKeys = tx.transaction.message.getAccountKeys();
    const signerKeys: string[] = [];

    // The first N account keys (where N = number of signatures) are the signers
    const numSignatures =
      "header" in tx.transaction.message
        ? (
            tx.transaction.message as {
              header: { numRequiredSignatures: number };
            }
          ).header.numRequiredSignatures
        : tx.transaction.signatures.length;

    for (let i = 0; i < numSignatures; i++) {
      const key = accountKeys.get(i);
      if (key) {
        signerKeys.push(key.toBase58());
      }
    }

    let expectedPubkey: PublicKey;
    try {
      expectedPubkey = new PublicKey(expectedWallet);
    } catch {
      return { verified: false, reason: "Invalid expected wallet address" };
    }

    if (!signerKeys.includes(expectedPubkey.toBase58())) {
      return {
        verified: false,
        reason: "Expected wallet is not a signer of this transaction",
      };
    }

    // --- Verify reference in instruction data or logs ---
    const referenceFound = checkForReference(tx, expectedReference);

    if (!referenceFound) {
      return {
        verified: false,
        reason:
          "Expected reference not found in transaction instructions or logs",
      };
    }

    return { verified: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { verified: false, reason: `Verification error: ${message}` };
  }
}

/**
 * Adapter wrapper around the legacy generic verifier. Registered
 * below at module load so the default dispatch path is unchanged
 * for pre-refactor callers.
 */
const completionGenericV1: VerificationAdapter = {
  id: "completion.generic.v1",
  async verify(args: VerifyArgs): Promise<VerificationResult> {
    // The generic adapter REQUIRES an expected reference — that's
    // the whole point of the memo-based check. Missing reference is
    // a misconfigured publish, not a user error.
    if (!args.expectedReference) {
      return {
        ok: false,
        reason: "completion.generic.v1 requires expectedReference",
      };
    }
    const legacy = await verifyCompletion(
      args.signature,
      args.expectedWallet,
      args.expectedReference,
      args.rpcUrl,
    );
    if (legacy.verified) {
      return { ok: true };
    }
    return { ok: false, reason: legacy.reason ?? "Verification failed" };
  },
};

registerAdapter(completionGenericV1);

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Check whether the expected reference appears in:
 * - Instruction data (base58 or UTF-8 representation)
 * - Transaction log messages (e.g., memo program output)
 */
function checkForReference(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  expectedReference: string,
): boolean {
  // Check log messages first (most common for memo programs)
  const logMessages: string[] = tx.meta?.logMessages ?? [];
  for (const log of logMessages) {
    if (log.includes(expectedReference)) {
      return true;
    }
  }

  // Check raw instruction data
  const message = tx.transaction.message;
  const compiledInstructions =
    "compiledInstructions" in message
      ? (message.compiledInstructions as Array<{ data: Uint8Array }>)
      : null;

  if (compiledInstructions) {
    for (const ix of compiledInstructions) {
      const dataStr = Buffer.from(ix.data).toString("utf8");
      if (dataStr.includes(expectedReference)) {
        return true;
      }
    }
  }

  // Legacy message format
  const instructions =
    "instructions" in message
      ? (message.instructions as Array<{ data: string }>)
      : null;

  if (instructions) {
    for (const ix of instructions) {
      // `ix.data` is base58-encoded in legacy format; try decoding as UTF-8
      if (ix.data && ix.data.includes(expectedReference)) {
        return true;
      }
      // Also try the raw buffer
      try {
        const buf = Buffer.from(ix.data, "base64");
        if (buf.toString("utf8").includes(expectedReference)) {
          return true;
        }
      } catch {
        // ignore decode errors
      }
    }
  }

  return false;
}
