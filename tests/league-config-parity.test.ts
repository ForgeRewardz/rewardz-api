import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVNET, MAINNET, loadLeagueConfig } from "@rewardz/types";
import type { LeagueConfig } from "@rewardz/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const KEEPER_DIR = path.join(REPO_ROOT, "mvp-keeper-bot");

/**
 * Dump the Rust `LeagueConfig` for the given network by running the keeper-bot's
 * `print-league-config` subcommand (or an ad-hoc `cargo run`-backed bin). We shell out
 * so the Rust side is exercised end-to-end — this is the only way to detect drift
 * between the two presets.
 *
 * In CI this runs against the installed Rust toolchain. If cargo is unavailable
 * locally, the test is skipped with a clear message so devs are not blocked.
 */
function dumpRust(network: "devnet" | "mainnet"): LeagueConfig {
  const output = execFileSync(
    "cargo",
    ["run", "--quiet", "--bin", "mvp-keeper-bot", "--", "print-league-config"],
    {
      cwd: KEEPER_DIR,
      env: { ...process.env, SOLANA_NETWORK: network },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  // Contract: `print-league-config` emits ONLY the JSON config on stdout
  // (tracing writes to stderr, which is inherited). Parse the whole stdout
  // as JSON — no slicing heuristics.
  return JSON.parse(output.trim()) as LeagueConfig;
}

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PARITY_REQUIRED =
  process.env.CI === "true" || process.env.LEAGUE_PARITY_REQUIRED === "1";

function tryDumpRust(network: "devnet" | "mainnet"): LeagueConfig | null {
  if (!hasCargo()) {
    console.warn(
      `skipping Rust parity for ${network}: cargo not available. ` +
        `Set LEAGUE_PARITY_REQUIRED=1 (or run in CI) to fail instead.`,
    );
    return null;
  }
  try {
    return dumpRust(network);
  } catch (err) {
    if (PARITY_REQUIRED) throw err;
    console.warn(
      `skipping Rust parity for ${network}: cargo build/run failed ` +
        `(${(err as Error).message.split("\n")[0]}). ` +
        `Set LEAGUE_PARITY_REQUIRED=1 to fail instead.`,
    );
    return null;
  }
}

describe("LeagueConfig TS ↔ Rust parity", () => {
  it("TS DEVNET preset deep-equals Rust DEVNET preset", () => {
    const rust = tryDumpRust("devnet");
    if (rust === null) return;
    expect(rust).toEqual(DEVNET);
  });

  it("TS MAINNET preset deep-equals Rust MAINNET preset", () => {
    const rust = tryDumpRust("mainnet");
    if (rust === null) return;
    expect(rust).toEqual(MAINNET);
  });

  it("loadLeagueConfig respects SOLANA_NETWORK=devnet", () => {
    expect(loadLeagueConfig({ SOLANA_NETWORK: "devnet" })).toEqual(DEVNET);
  });

  it("loadLeagueConfig respects SOLANA_NETWORK=mainnet", () => {
    expect(loadLeagueConfig({ SOLANA_NETWORK: "mainnet" })).toEqual(MAINNET);
  });

  it("loadLeagueConfig throws on unknown network", () => {
    expect(() => loadLeagueConfig({ SOLANA_NETWORK: "testnet" })).toThrow(
      /Unknown SOLANA_NETWORK/,
    );
    expect(() => loadLeagueConfig({})).toThrow(/Unknown SOLANA_NETWORK/);
  });

  it("DEVNET quality_weights sum to 1.0", () => {
    const { U, R, C, S } = DEVNET.quality_weights;
    expect(U + R + C + S).toBeCloseTo(1.0, 6);
  });

  it("DEVNET ranking_weights sum to 1.0", () => {
    const { quality, unique_wallets, repeat_users, completions } =
      DEVNET.ranking_weights;
    expect(quality + unique_wallets + repeat_users + completions).toBeCloseTo(
      1.0,
      6,
    );
  });
});
