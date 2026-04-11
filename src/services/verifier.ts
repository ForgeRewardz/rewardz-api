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
/*  Steel-program adapters (stake.steel.v1 / mint.steel.v1)                   */
/* -------------------------------------------------------------------------- */

/**
 * Base58 pubkey of the rewardz-mvp Steel program. Read from
 * `REWARDZ_MVP_PROGRAM_ID` at module load with a safe fallback to
 * the fixture id used by the SDK unit tests. Tests that spin up
 * adapter coverage can set the env var before importing this
 * module to pin a specific id.
 *
 * We intentionally read `process.env` directly (instead of the
 * `config.ts` module) because the S1 invariant forbids touching
 * config.ts in this session — the env var still works, it just
 * bypasses the zod schema. A future housekeeping pass should move
 * this into config.ts so the pubkey shape is validated.
 */
const REWARDZ_MVP_PROGRAM_ID =
  process.env.REWARDZ_MVP_PROGRAM_ID ??
  "RewardzMVP11111111111111111111111111111111111";

/**
 * Discriminator for `userStake` — Steel / Pinocchio emit a single
 * u8 leading byte. See sdk/packages/sdk/src/blinks/__fixtures__/
 * rewardz-mvp.json and the dispatch table in program/src/lib.rs.
 */
const STAKE_DISCRIMINATOR = 5;

/**
 * Discriminator for `burnToMint`. Same layout as userStake — one
 * leading u8 byte followed by a little-endian u64 arg (`nonce` for
 * burnToMint, `amount` for userStake).
 */
const BURN_TO_MINT_DISCRIMINATOR = 17;

/**
 * Fetch a parsed, confirmed transaction and return the list of
 * program-instruction tuples so adapters can filter by program id.
 * Returns `null` on not-found or error-bearing txs.
 */
async function fetchConfirmedTx(
  signature: string,
  rpcUrl: string,
): Promise<import("@solana/web3.js").TransactionResponse | null> {
  const connection = new Connection(rpcUrl, "confirmed");
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;
  if (tx.meta?.err) return null;
  return tx as unknown as import("@solana/web3.js").TransactionResponse;
}

/**
 * Extract every instruction that targets the rewardz-mvp program id,
 * returning the raw data byte array for each. Tolerates both legacy
 * (`message.instructions`) and v0 (`message.compiledInstructions`)
 * message shapes.
 *
 * Compute-budget / ATA prelude ixs are left in place — the caller is
 * expected to search for a specific discriminator rather than trust
 * positional ordering, which keeps the adapter stable regardless of
 * the blink runtime's prelude choices.
 */
function extractRewardzIxDataSlices(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
): Uint8Array[] {
  const slices: Uint8Array[] = [];
  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys
    ? message.getAccountKeys()
    : null;

  const programIdFor = (idx: number): string | null => {
    if (accountKeys) {
      const k = accountKeys.get(idx);
      return k ? k.toBase58() : null;
    }
    // Legacy fallback.
    const staticKeys = message.accountKeys as PublicKey[] | undefined;
    if (staticKeys && staticKeys[idx]) {
      return staticKeys[idx].toBase58();
    }
    return null;
  };

  // v0 compiled instructions
  if (Array.isArray(message.compiledInstructions)) {
    for (const ix of message.compiledInstructions as Array<{
      programIdIndex: number;
      data: Uint8Array;
    }>) {
      const pid = programIdFor(ix.programIdIndex);
      if (pid === REWARDZ_MVP_PROGRAM_ID) {
        slices.push(
          ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data),
        );
      }
    }
  }

  // Legacy instructions
  if (Array.isArray(message.instructions)) {
    for (const ix of message.instructions as Array<{
      programIdIndex: number;
      data: string | Uint8Array;
    }>) {
      const pid = programIdFor(ix.programIdIndex);
      if (pid === REWARDZ_MVP_PROGRAM_ID) {
        if (typeof ix.data === "string") {
          // Legacy base58 is too expensive to decode here without
          // pulling in bs58; try base64 first, then UTF-8 fallback.
          try {
            slices.push(new Uint8Array(Buffer.from(ix.data, "base64")));
          } catch {
            slices.push(new Uint8Array(Buffer.from(ix.data, "utf8")));
          }
        } else {
          slices.push(
            ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data),
          );
        }
      }
    }
  }

  return slices;
}

/**
 * Read a little-endian u64 from the data slice at the given offset.
 * Throws if the slice is too short. Returned as bigint so callers can
 * round-trip through JSON / audit logs without precision loss.
 */
function readU64LE(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) {
    throw new Error(
      `data slice too short for u64 at offset ${offset}: ${data.length} bytes`,
    );
  }
  const view = new DataView(
    data.buffer,
    data.byteOffset + offset,
    8,
  );
  return view.getBigUint64(0, true);
}

/**
 * Assert that `expectedWallet` is a signer on the tx. Identical to
 * the generic adapter's check — extracted into a helper so every
 * steel adapter can apply the same gate.
 */
function assertSigner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  expectedWallet: string,
): { ok: true } | { ok: false; reason: string } {
  const accountKeys = tx.transaction.message.getAccountKeys();
  const signerKeys: string[] = [];
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
    if (key) signerKeys.push(key.toBase58());
  }

  let expectedPubkey: PublicKey;
  try {
    expectedPubkey = new PublicKey(expectedWallet);
  } catch {
    return { ok: false, reason: "Invalid expected wallet address" };
  }

  if (!signerKeys.includes(expectedPubkey.toBase58())) {
    return {
      ok: false,
      reason: "Expected wallet is not a signer of this transaction",
    };
  }

  return { ok: true };
}

/**
 * Adapter: `stake.steel.v1`.
 *
 * Decodes a `userStake` instruction from the rewardz-mvp Steel
 * program. Searches every instruction that targets the program id
 * for the stake discriminator (5) and unpacks the `amount` u64 arg.
 * The compute-budget / ATA prelude positional offsets are tolerated
 * by filtering on program id instead of assuming index 0/1.
 *
 * On success `amount` is returned so callers can apply eligibility
 * gates (min stake, max-per-wallet-per-day, etc.) without re-fetching
 * the tx.
 */
const stakeSteelV1: VerificationAdapter = {
  id: "stake.steel.v1",
  async verify(args: VerifyArgs): Promise<VerificationResult> {
    try {
      const tx = await fetchConfirmedTx(args.signature, args.rpcUrl);
      if (!tx) {
        return { ok: false, reason: "Transaction not found or failed" };
      }

      const signerCheck = assertSigner(tx, args.expectedWallet);
      if (!signerCheck.ok) return signerCheck;

      const slices = extractRewardzIxDataSlices(tx);
      for (const data of slices) {
        if (data.length >= 1 && data[0] === STAKE_DISCRIMINATOR) {
          // Expect: 1 discriminator byte + 8 little-endian bytes (amount u64).
          let amount: bigint;
          try {
            amount = readU64LE(data, 1);
          } catch (err) {
            return {
              ok: false,
              reason: `userStake decode failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          return {
            ok: true,
            amount,
            meta: { discriminator: STAKE_DISCRIMINATOR },
          };
        }
      }

      return {
        ok: false,
        reason: "No userStake instruction found in transaction",
      };
    } catch (err) {
      return {
        ok: false,
        reason: `stake.steel.v1 error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

registerAdapter(stakeSteelV1);

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
