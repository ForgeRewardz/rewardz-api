/**
 * Unit tests for the intent resolver's rules-based matcher and the
 * resolveIntent fallback path. Covers the protocol-specific rules
 * (marinade/jupiter/kamino) added for the onboarded protocols plus the
 * backward-compatible generic rules. Does NOT test the Gemini path or the
 * rate-limiter exhaustion — those require integration / ops testing.
 *
 * GEMINI_API_KEY is deliberately left unset so resolveIntent always
 * exercises the rules path. The minimum env vars required by src/config.ts
 * are seeded globally by tests/setup-env.ts (vitest setupFiles).
 *
 * See mini-app-ux-spec.md §7.5 for the rate-limit fallback spec.
 */

import { describe, expect, it } from "vitest";
import {
  matchRules,
  resolveIntent,
} from "../../src/services/intent-resolver.js";

const WALLET = "11111111111111111111111111111111";

describe("matchRules — protocol-specific rules", () => {
  it("matches 'stake 1 SOL on marinade' with protocol_hint", () => {
    const result = matchRules("stake 1 SOL on marinade");
    expect(result).toEqual({
      action_type: "stake",
      params: {
        asset: "SOL",
        amount: 1,
        protocol_hint: "marinade",
      },
    });
  });

  it("matches 'swap 50 USDC to SOL on jupiter' with protocol_hint", () => {
    const result = matchRules("swap 50 USDC to SOL on jupiter");
    expect(result).toEqual({
      action_type: "swap",
      params: {
        asset_in: "USDC",
        asset_out: "SOL",
        amount_in: 50,
        protocol_hint: "jupiter",
      },
    });
  });

  it("matches 'borrow 100 USDC on kamino' with protocol_hint", () => {
    const result = matchRules("borrow 100 USDC on kamino");
    expect(result).toEqual({
      action_type: "borrow",
      params: {
        asset: "USDC",
        amount: 100,
        protocol_hint: "kamino",
      },
    });
  });

  it("matches 'lend 250 USDC on kamino' with protocol_hint", () => {
    const result = matchRules("lend 250 USDC on kamino");
    expect(result).toEqual({
      action_type: "lend",
      params: {
        asset: "USDC",
        amount: 250,
        protocol_hint: "kamino",
      },
    });
  });
});

describe("matchRules — generic rules (backward compatibility)", () => {
  it("still matches 'stake 5 SOL' without protocol hint", () => {
    const result = matchRules("stake 5 SOL");
    expect(result).toEqual({
      action_type: "stake",
      params: {
        asset: "SOL",
        amount: 5,
      },
    });
    // Guard: no protocol_hint leaked from the specific rules.
    expect(result?.params).not.toHaveProperty("protocol_hint");
  });

  it("matches 'swap USDC to SOL' without protocol hint", () => {
    const result = matchRules("swap USDC to SOL");
    expect(result).toEqual({
      action_type: "swap",
      params: {
        asset_in: "USDC",
        asset_out: "SOL",
      },
    });
  });

  it("returns null for an unmatched query", () => {
    expect(matchRules("hello world")).toBeNull();
  });
});

describe("resolveIntent — rules fallback path", () => {
  it("returns resolver_type 'rules' for a protocol-specific query when Gemini is unset", async () => {
    const result = await resolveIntent("stake 1 SOL on marinade", WALLET, []);
    expect(result.resolver_type).toBe("rules");
    expect(result.action_type).toBe("stake");
    expect(result.params).toMatchObject({
      asset: "SOL",
      amount: 1,
      protocol_hint: "marinade",
    });
    expect(result.confidence).toBe(0.7);
    expect(result.offers).toEqual([]);
  });

  it("returns a low-confidence 'custom' result for an unmatched query", async () => {
    const result = await resolveIntent("asdfghjkl qwerty", WALLET, []);
    expect(result).toMatchObject({
      action_type: "custom",
      confidence: 0.3,
      resolver_type: "rules",
      offers: [],
    });
    expect(result.params).toMatchObject({ raw_query: "asdfghjkl qwerty" });
  });
});
