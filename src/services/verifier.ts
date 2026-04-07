import { Connection, PublicKey } from "@solana/web3.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface VerificationResult {
  verified: boolean;
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Verify that an on-chain transaction meets the expected criteria.
 *
 * Checks:
 * 1. Transaction exists and is confirmed
 * 2. The expected wallet is among the signers
 * 3. The expected reference string appears in instruction data or memo
 */
export async function verifyCompletion(
  signature: string,
  expectedWallet: string,
  expectedReference: string,
  rpcUrl: string,
): Promise<VerificationResult> {
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
