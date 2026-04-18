/**
 * Shared formatting helpers for discovery-resolver results.
 *
 * `formatAssistantText` and `resolverFellBackToRules` are used by BOTH the
 * synchronous `POST /v1/discovery/query` handler AND the async
 * `discovery-runner` worker that fulfils scheduled queries. Keeping the
 * two call-sites wired to one implementation guarantees the mini-app UX
 * renders identically whether the result came from an immediate query or
 * a background job.
 *
 * See routes/discovery.ts (§POST /discovery/query) and
 * workers/discovery-runner.ts for the consumers.
 */

import { config } from "../config.js";
import type { IntentResult } from "./intent-resolver.js";
import type { IntentAction } from "../types/index.js";

/**
 * Human-readable assistant reply for a resolved intent. Deterministic —
 * no LLM in the loop — so tests can assert exact substrings and the
 * mini-app composer can render without a second round-trip.
 */
export function formatAssistantText(result: IntentResult): string {
  const params = result.params as Record<string, unknown>;
  const amount =
    typeof params.amount === "number"
      ? String(params.amount)
      : typeof params.amount_in === "number"
        ? String(params.amount_in)
        : null;
  const asset =
    typeof params.asset === "string"
      ? params.asset
      : typeof params.asset_in === "string"
        ? params.asset_in
        : null;

  switch (result.action_type as IntentAction) {
    case "stake":
      return amount && asset
        ? `I can help you stake ${amount} ${asset}.`
        : asset
          ? `I can help you stake ${asset}.`
          : "I can help you stake.";
    case "swap": {
      const assetOut =
        typeof params.asset_out === "string" ? params.asset_out : null;
      if (amount && asset && assetOut) {
        return `I can help you swap ${amount} ${asset} to ${assetOut}.`;
      }
      if (asset && assetOut) {
        return `I can help you swap ${asset} to ${assetOut}.`;
      }
      return "I can help you swap tokens.";
    }
    case "lend":
      return amount && asset
        ? `I can help you lend ${amount} ${asset}.`
        : "I can help you lend.";
    case "borrow":
      return amount && asset
        ? `I can help you borrow ${amount} ${asset}.`
        : "I can help you borrow.";
    case "transfer":
      return amount
        ? `I can help you transfer ${amount}.`
        : "I can help you transfer.";
    case "mint":
      return "I can help you mint.";
    case "vote":
      return "I can help you vote.";
    case "tweet":
      return "I can help you post on X.";
    case "burn":
      return "I can help you burn tokens.";
    default:
      return "I'm not sure I can do that yet — here are some things you can try.";
  }
}

/**
 * True when Gemini is configured AND the resolver still returned `rules`
 * — i.e. the AI path failed or was rate-limited and the rules matcher
 * took over (per spec §7.4). When no Gemini key is present the resolver
 * always returns `rules` by design, so reporting "fell back" there would
 * be misleading.
 */
export function resolverFellBackToRules(result: IntentResult): boolean {
  return Boolean(config.GEMINI_API_KEY) && result.resolver_type === "rules";
}
