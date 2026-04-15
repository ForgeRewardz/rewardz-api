/**
 * Unit tests for the F8 TS port of the on-chain PRNG + reward formula.
 *
 * Fixtures in tests/fixtures/game-prng.json are emitted by a small Rust
 * program that calls `sha3::Keccak256` — the exact dependency used by
 * `mvp-smart-contracts/program/src/game_round.rs`. That program is not
 * checked into this repo; re-run `cargo run --release` inside
 * `tools/f8-fixture-gen` (out-of-tree) to regenerate. The fixture carries
 * the empty-string Keccak-256 digest as a sanity vector so we'd notice if
 * the embedded TS keccak implementation silently regressed to SHA3.
 */

// Config is loaded transitively via src/db/client.ts. The pure-function
// tests below don't hit the pool, but the import must still parse, so seed
// the required env vars before the service module evaluates.
process.env.JWT_SECRET ??= "test-jwt-secret-game-service";
process.env.INTERNAL_API_KEY ??= "test-internal-api-key-game-service";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

type GameServiceModule = typeof import("../../src/services/game-service.js");
type Keccak256Module = typeof import("../../src/services/keccak256.js");

let computePlayerHit: GameServiceModule["computePlayerHit"];
let computeMotherlodeHit: GameServiceModule["computeMotherlodeHit"];
let computeMotherlodeShare: GameServiceModule["computeMotherlodeShare"];
let computeRewardAmount: GameServiceModule["computeRewardAmount"];
let synthesizePlayerOutcome: GameServiceModule["synthesizePlayerOutcome"];
let parseGameProgramLog: GameServiceModule["parseGameProgramLog"];
let keccak256: Keccak256Module["keccak256"];

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "..", "fixtures", "game-prng.json");

interface PlayerHitCase {
  slotHashHex: string;
  roundId: string;
  settleTimestamp: string;
  walletAddress: string;
  hitRateBps: number;
  expectedIsHit: boolean;
  digestU64: string;
}

interface MotherlodeCase {
  slotHashHex: string;
  roundId: string;
  probabilityBps: number;
  expectedIsHit: boolean;
  digestU64: string;
}

interface RewardCase {
  isHit: boolean;
  pointsDeployed: string;
  totalPointsDeployed: string;
  hitRateBps: number;
  tokensMinted: string;
  expectedReward: string;
}

interface MotherlodeShareCase {
  isHit: boolean;
  motherlodeTriggered: boolean;
  motherlodeAmount: string;
  pointsDeployed: string;
  totalHitPoints: string;
  expectedShare: string;
}

interface Fixture {
  generator: string;
  keccak_variant: string;
  keccak_empty: string;
  slot_hashes: string[];
  player_hit: PlayerHitCase[];
  motherlode_hit: MotherlodeCase[];
  reward_amount: RewardCase[];
  motherlode_share: MotherlodeShareCase[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

beforeAll(async () => {
  const gameService = await import("../../src/services/game-service.js");
  computePlayerHit = gameService.computePlayerHit;
  computeMotherlodeHit = gameService.computeMotherlodeHit;
  computeMotherlodeShare = gameService.computeMotherlodeShare;
  computeRewardAmount = gameService.computeRewardAmount;
  synthesizePlayerOutcome = gameService.synthesizePlayerOutcome;
  parseGameProgramLog = gameService.parseGameProgramLog;
  const keccakMod = await import("../../src/services/keccak256.js");
  keccak256 = keccakMod.keccak256;
});

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

describe("keccak256 sanity", () => {
  it("digests the empty string to the Keccak-256 (pre-NIST) vector", () => {
    // If this flips to SHA3-256's b"" digest (a7ffc6f8bf1ed7…) the padding
    // byte has drifted to 0x06 and compute_player_hit will silently diverge.
    expect(bytesToHex(keccak256(new Uint8Array(0)))).toBe(fixture.keccak_empty);
    expect(fixture.keccak_empty).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });
});

describe("computePlayerHit (Rust-generated fixtures)", () => {
  it("matches every Rust-emitted case byte-for-byte", () => {
    expect(fixture.player_hit.length).toBeGreaterThan(0);
    for (const c of fixture.player_hit) {
      const isHit = computePlayerHit({
        slotHash: hexToBytes(c.slotHashHex),
        roundId: BigInt(c.roundId),
        settleTimestamp: BigInt(c.settleTimestamp),
        walletAddress: c.walletAddress,
        hitRateBps: c.hitRateBps,
      });
      expect(
        isHit,
        `roundId=${c.roundId} ts=${c.settleTimestamp} wallet=${c.walletAddress} bps=${c.hitRateBps}`,
      ).toBe(c.expectedIsHit);
    }
  });

  it("rejects slot hashes that are not exactly 32 bytes", () => {
    expect(() =>
      computePlayerHit({
        slotHash: new Uint8Array(31),
        roundId: 1n,
        settleTimestamp: 0n,
        walletAddress: fixture.player_hit[0].walletAddress,
        hitRateBps: 5000,
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("computeMotherlodeHit (Rust-generated fixtures)", () => {
  it("matches every Rust-emitted case", () => {
    expect(fixture.motherlode_hit.length).toBeGreaterThan(0);
    for (const c of fixture.motherlode_hit) {
      const isHit = computeMotherlodeHit({
        slotHash: hexToBytes(c.slotHashHex),
        roundId: BigInt(c.roundId),
        probabilityBps: c.probabilityBps,
      });
      expect(isHit, `roundId=${c.roundId} prob_bps=${c.probabilityBps}`).toBe(
        c.expectedIsHit,
      );
    }
  });
});

describe("computeRewardAmount (pro-rata + clamp)", () => {
  it("matches every Rust-emitted reward case", () => {
    expect(fixture.reward_amount.length).toBeGreaterThan(0);
    for (const c of fixture.reward_amount) {
      const got = computeRewardAmount({
        isHit: c.isHit,
        pointsDeployed: BigInt(c.pointsDeployed),
        totalPointsDeployed: BigInt(c.totalPointsDeployed),
        hitRateBps: c.hitRateBps,
        tokensMinted: BigInt(c.tokensMinted),
      });
      expect(got.toString()).toBe(c.expectedReward);
    }
  });
});

describe("computeMotherlodeShare (pre-F3 per-player pro-rata)", () => {
  it("matches every Rust-emitted share case", () => {
    expect(fixture.motherlode_share.length).toBeGreaterThanOrEqual(3);
    for (const c of fixture.motherlode_share) {
      const got = computeMotherlodeShare({
        isHit: c.isHit,
        motherlodeTriggered: c.motherlodeTriggered,
        motherlodeAmount: BigInt(c.motherlodeAmount),
        pointsDeployed: BigInt(c.pointsDeployed),
        totalHitPoints: BigInt(c.totalHitPoints),
      });
      expect(
        got.toString(),
        `hit=${c.isHit} trig=${c.motherlodeTriggered} amt=${c.motherlodeAmount} pts=${c.pointsDeployed}/${c.totalHitPoints}`,
      ).toBe(c.expectedShare);
    }
  });
});

describe("synthesizePlayerOutcome", () => {
  const aCase = fixture.player_hit.find((c) => c.expectedIsHit === true)!;
  const slot = hexToBytes(aCase.slotHashHex);

  it("short-circuits to zero on refund_mode regardless of hit", () => {
    const result = synthesizePlayerOutcome({
      slotHash: slot,
      roundId: BigInt(aCase.roundId),
      settleTimestamp: BigInt(aCase.settleTimestamp),
      walletAddress: aCase.walletAddress,
      hitRateBps: aCase.hitRateBps,
      pointsDeployed: 500n,
      totalPointsDeployed: 1000n,
      tokensMinted: 1000n,
      refundMode: true,
    });
    expect(result).toEqual({
      isHit: false,
      rewardAmount: 0n,
      motherlodeShare: 0n,
    });
  });

  it("returns all three fields for a hit case in non-refund mode", () => {
    const result = synthesizePlayerOutcome({
      slotHash: slot,
      roundId: BigInt(aCase.roundId),
      settleTimestamp: BigInt(aCase.settleTimestamp),
      walletAddress: aCase.walletAddress,
      hitRateBps: aCase.hitRateBps,
      pointsDeployed: 500n,
      totalPointsDeployed: 1000n,
      tokensMinted: 1000n,
      refundMode: false,
    });
    expect(result.isHit).toBe(true);
    // expected_hit_points = max(1000 * bps / 10_000, 500). For bps=5000
    // proportional = 500 so expected = 500 and reward = 1000 * 500 / 500.
    if (aCase.hitRateBps === 5000) {
      expect(result.rewardAmount).toBe(1000n);
    } else {
      expect(result.rewardAmount).toBeGreaterThanOrEqual(0n);
    }
    // Without motherlode* fields, share defaults to 0.
    expect(result.motherlodeShare).toBe(0n);
  });

  it("propagates motherlode_share when motherlode_triggered=true", () => {
    const result = synthesizePlayerOutcome({
      slotHash: slot,
      roundId: BigInt(aCase.roundId),
      settleTimestamp: BigInt(aCase.settleTimestamp),
      walletAddress: aCase.walletAddress,
      hitRateBps: aCase.hitRateBps,
      pointsDeployed: 100n,
      totalPointsDeployed: 1000n,
      tokensMinted: 1000n,
      refundMode: false,
      motherlodeTriggered: true,
      motherlodeAmount: 1000n,
      totalHitPoints: 400n,
    });
    // is_hit propagated from compute_player_hit for this wallet/round.
    if (result.isHit) {
      // 1000 * 100 / 400 = 250
      expect(result.motherlodeShare).toBe(250n);
    } else {
      expect(result.motherlodeShare).toBe(0n);
    }
  });
});

// ── parseGameProgramLog — wire-format coverage for the post-F3 layouts ──

function encodeLog(name: string, payload: Uint8Array): string {
  const nameB64 = Buffer.from(name, "utf8").toString("base64");
  const payloadB64 = Buffer.from(payload).toString("base64");
  return `Program data: ${nameB64} ${payloadB64}`;
}

function writeLeU64(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

function writeLeI64(view: DataView, offset: number, value: bigint): void {
  view.setBigInt64(offset, value, true);
}

describe("parseGameProgramLog — post-F3 events", () => {
  it("decodes the 33-byte RoundSettled snapshot payload", () => {
    const buf = Buffer.alloc(33);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    writeLeU64(view, 0, 42n);
    writeLeI64(view, 8, 1_700_000_000n);
    writeLeU64(view, 16, 999_999n);
    buf[24] = 1;
    writeLeU64(view, 25, 1_234_567n);

    const parsed = parseGameProgramLog(encodeLog("RoundSettled", buf));
    expect(parsed).toEqual({
      eventName: "RoundSettled",
      roundId: "42",
      settleTimestamp: "1700000000",
      expiresAt: "999999",
      refundMode: true,
      totalPointsDeployed: "1234567",
    });
  });

  it("decodes RoundSettled with refund_mode = false", () => {
    const buf = Buffer.alloc(33);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    writeLeU64(view, 0, 7n);
    writeLeI64(view, 8, -1n);
    writeLeU64(view, 16, 100n);
    buf[24] = 0;
    writeLeU64(view, 25, 0n);
    const parsed = parseGameProgramLog(encodeLog("RoundSettled", buf));
    expect(parsed).toMatchObject({
      eventName: "RoundSettled",
      roundId: "7",
      settleTimestamp: "-1",
      refundMode: false,
      totalPointsDeployed: "0",
    });
  });

  it("decodes the 49-byte CheckpointRecorded payload", () => {
    const buf = Buffer.alloc(49);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    writeLeU64(view, 0, 42n);
    // authority bytes: pubkey for "So11111111111111111111111111111111111111112"
    const authority = Buffer.from(
      new PublicKey("So11111111111111111111111111111111111111112").toBytes(),
    );
    authority.copy(buf, 8);
    writeLeU64(view, 40, 12345n);
    buf[48] = 1;

    const parsed = parseGameProgramLog(encodeLog("CheckpointRecorded", buf));
    expect(parsed).toEqual({
      eventName: "CheckpointRecorded",
      roundId: "42",
      walletAddress: "So11111111111111111111111111111111111111112",
      rewardAmount: "12345",
      isHit: true,
    });
  });

  it("decodes the 16-byte MotherlodeTriggered payload", () => {
    const buf = Buffer.alloc(16);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    writeLeU64(view, 0, 42n);
    writeLeU64(view, 8, 5_000_000n);

    const parsed = parseGameProgramLog(encodeLog("MotherlodeTriggered", buf));
    expect(parsed).toEqual({
      eventName: "MotherlodeTriggered",
      roundId: "42",
      motherlodeAmount: "5000000",
    });
  });

  it("returns null for messages without the 'Program data:' prefix", () => {
    expect(parseGameProgramLog("Program log: hello")).toBeNull();
  });

  it("returns null for unknown event names", () => {
    expect(
      parseGameProgramLog(encodeLog("NeverHeardOfIt", Buffer.alloc(8))),
    ).toBeNull();
  });
});
