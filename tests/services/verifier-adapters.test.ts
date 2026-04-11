/**
 * Unit tests for the verification-adapter dispatch registry.
 *
 * Covers plan task 79 acceptance:
 *
 *   - completion.generic.v1 is registered at module load
 *   - stake.steel.v1 decodes userStake discriminator + amount
 *   - mint.steel.v1 decodes burnToMint discriminator + nonce
 *   - dispatchVerification("unknown.adapter.v0", ...) throws
 *
 * The steel adapters fetch txs via @solana/web3.js Connection.
 * Rather than spin up a real RPC, the test monkey-patches
 * `Connection.prototype.getTransaction` to return a synthetic
 * confirmed tx with the expected program id + discriminator byte +
 * u64 arg layout.
 *
 * This suite does NOT need a Postgres pool — the verifier module
 * is pool-free. We still gate on TEST_DATABASE_URL anyway so it
 * runs alongside the other integration tests and silently skips
 * on bare dev boxes, matching the house convention.
 */

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-verifier-adapters";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-verifier-adapters";
process.env.ADMIN_WALLETS ??= "11111111111111111111111111111111";
// Pin the program id used by the adapters so synthetic txs decode
// against a known constant regardless of any local .env drift.
process.env.REWARDZ_MVP_PROGRAM_ID =
  "RewardzMVP11111111111111111111111111111111111";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";

type VerifierModule = typeof import("../../src/services/verifier.js");

let verifier: VerifierModule;

const SKIP = !process.env.TEST_DATABASE_URL;

const PAYER = "So11111111111111111111111111111111111111112";
const REWARDZ_PROGRAM_ID = "RewardzMVP11111111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";

const originalGetTransaction = Connection.prototype.getTransaction;

/**
 * Build a synthetic `getTransaction` response with:
 *   - the payer as the first account (signer)
 *   - a compute-budget noop at ix[0]
 *   - a rewardz-mvp ix at ix[1] with the given discriminator + u64 arg
 *
 * Returns an object shaped enough like the real response for the
 * adapter's decode path. The adapter only touches
 * `tx.transaction.message.getAccountKeys`, `header.numRequiredSignatures`,
 * and `compiledInstructions[].{ programIdIndex, data }`.
 */
function makeSyntheticTx(
  discriminator: number,
  arg: bigint,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
any {
  const payerKey = new PublicKey(PAYER);
  const programKey = new PublicKey(REWARDZ_PROGRAM_ID);
  const computeKey = new PublicKey(COMPUTE_BUDGET_PROGRAM_ID);

  const accountKeys = [payerKey, programKey, computeKey];

  const data = new Uint8Array(9);
  data[0] = discriminator;
  const view = new DataView(data.buffer);
  view.setBigUint64(1, arg, true);

  return {
    transaction: {
      message: {
        header: { numRequiredSignatures: 1 },
        compiledInstructions: [
          { programIdIndex: 2, data: new Uint8Array([0]) },
          { programIdIndex: 1, data },
        ],
        getAccountKeys() {
          return {
            get: (i: number) => accountKeys[i] ?? null,
          };
        },
      },
      signatures: ["fakesig"],
    },
    meta: { err: null, logMessages: [] },
  };
}

function installTxStub(
  impl: (signature: string) => unknown,
): void {
  Connection.prototype.getTransaction = (async (
    signature: string,
  ) => {
    return impl(signature);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function restoreTxStub(): void {
  Connection.prototype.getTransaction = originalGetTransaction;
}

/* -------------------------------------------------------------------------- */
/*  Suite                                                                     */
/* -------------------------------------------------------------------------- */

describe.skipIf(SKIP)("verifier adapters", () => {
  beforeAll(async () => {
    verifier = await import("../../src/services/verifier.js");
  });

  afterEach(() => {
    restoreTxStub();
  });

  afterAll(() => {
    restoreTxStub();
  });

  /* ------------------------------------------------------------------ */
  /*  Registry                                                          */
  /* ------------------------------------------------------------------ */

  it("registers completion.generic.v1, stake.steel.v1, mint.steel.v1 at boot", () => {
    const ids = verifier.listAdapters();
    expect(ids).toContain("completion.generic.v1");
    expect(ids).toContain("stake.steel.v1");
    expect(ids).toContain("mint.steel.v1");
    expect(ids.length).toBe(3);
  });

  it("dispatchVerification throws on an unknown adapter id", async () => {
    await expect(
      verifier.dispatchVerification("unknown.adapter.v0", {
        signature: "sig",
        expectedWallet: PAYER,
        rpcUrl: "http://localhost:9999",
      }),
    ).rejects.toThrow(/unknown verification adapter/i);
  });

  /* ------------------------------------------------------------------ */
  /*  stake.steel.v1                                                    */
  /* ------------------------------------------------------------------ */

  it("stake.steel.v1 decodes a synthetic userStake tx and returns amount", async () => {
    installTxStub(() => makeSyntheticTx(5, 1234n));

    const result = await verifier.dispatchVerification("stake.steel.v1", {
      signature: "sig",
      expectedWallet: PAYER,
      rpcUrl: "http://localhost:9999",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.amount).toBe(1234n);
      expect(result.meta?.discriminator).toBe(5);
    }
  });

  it("stake.steel.v1 rejects a tx with the wrong signer", async () => {
    installTxStub(() => makeSyntheticTx(5, 1234n));

    const result = await verifier.dispatchVerification("stake.steel.v1", {
      signature: "sig",
      // Correct base58 length but different account than the tx's signer.
      expectedWallet: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      rpcUrl: "http://localhost:9999",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not a signer/i);
    }
  });

  it("stake.steel.v1 rejects a tx with no userStake ix (discriminator mismatch)", async () => {
    installTxStub(() => makeSyntheticTx(99, 1234n));

    const result = await verifier.dispatchVerification("stake.steel.v1", {
      signature: "sig",
      expectedWallet: PAYER,
      rpcUrl: "http://localhost:9999",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no userStake/i);
    }
  });

  /* ------------------------------------------------------------------ */
  /*  mint.steel.v1                                                     */
  /* ------------------------------------------------------------------ */

  it("mint.steel.v1 decodes a synthetic burnToMint tx and returns nonce in meta", async () => {
    installTxStub(() => makeSyntheticTx(17, 42n));

    const result = await verifier.dispatchVerification("mint.steel.v1", {
      signature: "sig",
      expectedWallet: PAYER,
      rpcUrl: "http://localhost:9999",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.discriminator).toBe(17);
      expect(result.meta?.nonce).toBe("42");
    }
  });

  it("mint.steel.v1 rejects a tx missing the burnToMint discriminator", async () => {
    installTxStub(() => makeSyntheticTx(5, 42n));

    const result = await verifier.dispatchVerification("mint.steel.v1", {
      signature: "sig",
      expectedWallet: PAYER,
      rpcUrl: "http://localhost:9999",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no burnToMint/i);
    }
  });

  /* ------------------------------------------------------------------ */
  /*  completion.generic.v1                                             */
  /* ------------------------------------------------------------------ */

  it("completion.generic.v1 rejects when the reference is absent", async () => {
    installTxStub(() => ({
      transaction: {
        message: {
          header: { numRequiredSignatures: 1 },
          compiledInstructions: [
            { programIdIndex: 1, data: new Uint8Array([0]) },
          ],
          instructions: [],
          getAccountKeys() {
            return {
              get: (i: number) =>
                [new PublicKey(PAYER), new PublicKey(COMPUTE_BUDGET_PROGRAM_ID)][
                  i
                ] ?? null,
            };
          },
        },
        signatures: ["fakesig"],
      },
      meta: { err: null, logMessages: [] },
    }));

    const result = await verifier.dispatchVerification(
      "completion.generic.v1",
      {
        signature: "sig",
        expectedWallet: PAYER,
        expectedReference: "missing-ref",
        rpcUrl: "http://localhost:9999",
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/reference/i);
    }
  });

  it("completion.generic.v1 requires expectedReference and rejects without it", async () => {
    // No stub needed — the adapter short-circuits before fetching the tx.
    const result = await verifier.dispatchVerification(
      "completion.generic.v1",
      {
        signature: "sig",
        expectedWallet: PAYER,
        rpcUrl: "http://localhost:9999",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/expectedReference/i);
    }
  });
});
