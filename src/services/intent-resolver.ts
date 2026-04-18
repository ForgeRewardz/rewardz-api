import { config } from "../config.js";
import type { IntentAction, Protocol } from "../types/index.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ResolvedOffer {
  protocol_id: string;
  protocol_name: string;
  action_type: IntentAction;
  points: number;
}

export interface IntentResult {
  action_type: IntentAction;
  params: Record<string, unknown>;
  confidence: number;
  resolver_type: "ai" | "rules";
  offers: ResolvedOffer[];
}

/* -------------------------------------------------------------------------- */
/*  Rules-based resolver                                                      */
/* -------------------------------------------------------------------------- */

interface RuleMatch {
  action_type: IntentAction;
  params: Record<string, unknown>;
}

export function matchRules(queryStr: string): RuleMatch | null {
  const q = queryStr.trim().toLowerCase();

  // Protocol-specific rules (marinade / jupiter / kamino) — matched first so
  // a query like "stake 1 SOL on marinade" picks the correct protocol without
  // going through the generic "stake X" rule.
  const marinadeStake = q.match(
    /^stake\s+(\d+(?:\.\d+)?)\s+sol\s+(?:on|with)\s+marinade/i,
  );
  if (marinadeStake) {
    return {
      action_type: "stake",
      params: {
        asset: "SOL",
        amount: parseFloat(marinadeStake[1]),
        protocol_hint: "marinade",
      },
    };
  }

  const jupiterSwap = q.match(
    /^swap\s+(\d+(?:\.\d+)?)\s+(\S+)\s+(?:to|for)\s+(\S+)\s+(?:on|via|through)\s+jupiter/i,
  );
  if (jupiterSwap) {
    return {
      action_type: "swap",
      params: {
        asset_in: jupiterSwap[2].toUpperCase(),
        asset_out: jupiterSwap[3].toUpperCase(),
        amount_in: parseFloat(jupiterSwap[1]),
        protocol_hint: "jupiter",
      },
    };
  }

  const kaminoLendBorrow = q.match(
    /^(lend|borrow)\s+(\d+(?:\.\d+)?)\s+(\S+)\s+(?:on|with)\s+kamino/i,
  );
  if (kaminoLendBorrow) {
    return {
      action_type: kaminoLendBorrow[1].toLowerCase() as "lend" | "borrow",
      params: {
        asset: kaminoLendBorrow[3].toUpperCase(),
        amount: parseFloat(kaminoLendBorrow[2]),
        protocol_hint: "kamino",
      },
    };
  }

  // "swap X to Y" or "swap X for Y"
  const swapMatch = q.match(/^swap\s+(\S+)\s+(?:to|for)\s+(\S+)/i);
  if (swapMatch) {
    return {
      action_type: "swap",
      params: {
        asset_in: swapMatch[1].toUpperCase(),
        asset_out: swapMatch[2].toUpperCase(),
      },
    };
  }

  // "stake N SOL" or "stake SOL"
  const stakeMatch = q.match(/^stake\s+(?:(\d+(?:\.\d+)?)\s+)?(\S+)/i);
  if (stakeMatch) {
    const params: Record<string, unknown> = {
      asset: stakeMatch[2].toUpperCase(),
    };
    if (stakeMatch[1]) {
      params.amount = parseFloat(stakeMatch[1]);
    }
    return { action_type: "stake", params };
  }

  // "transfer N to ADDR"
  const transferMatch = q.match(
    /^(?:transfer|send)\s+(\d+(?:\.\d+)?)\s+(?:to\s+)?(\S+)/i,
  );
  if (transferMatch) {
    return {
      action_type: "transfer",
      params: { amount: parseFloat(transferMatch[1]), to: transferMatch[2] },
    };
  }

  // "mint" (simple keyword)
  if (/\bmint\b/i.test(q)) {
    return { action_type: "mint", params: {} };
  }

  // "lend N X" or "lend X"
  const lendMatch = q.match(/^lend\s+(?:(\d+(?:\.\d+)?)\s+)?(\S+)/i);
  if (lendMatch) {
    const params: Record<string, unknown> = {
      asset: lendMatch[2].toUpperCase(),
    };
    if (lendMatch[1]) {
      params.amount = parseFloat(lendMatch[1]);
    }
    return { action_type: "lend", params };
  }

  // "borrow N X"
  const borrowMatch = q.match(/^borrow\s+(?:(\d+(?:\.\d+)?)\s+)?(\S+)/i);
  if (borrowMatch) {
    const params: Record<string, unknown> = {
      asset: borrowMatch[2].toUpperCase(),
    };
    if (borrowMatch[1]) {
      params.amount = parseFloat(borrowMatch[1]);
    }
    return { action_type: "borrow", params };
  }

  return null;
}

function findOffers(
  actionType: IntentAction,
  protocolRegistry: Protocol[],
): ResolvedOffer[] {
  return protocolRegistry
    .filter(
      (p) => p.status === "active" && p.supported_actions.includes(actionType),
    )
    .map((p) => ({
      protocol_id: p.id,
      protocol_name: p.name,
      action_type: actionType,
      points: 0, // Points come from campaigns at route level
    }));
}

/* -------------------------------------------------------------------------- */
/*  AI stub resolver                                                          */
/* -------------------------------------------------------------------------- */

async function resolveWithAI(
  queryStr: string,
  _userWallet: string,
  protocolRegistry: Protocol[],
): Promise<IntentResult> {
  // Placeholder: actual Gemini integration will be added later.
  // For now, fall through to rules with an AI wrapper that returns
  // a plausible result to enable end-to-end testing.
  const ruleMatch = matchRules(queryStr);
  const actionType: IntentAction = ruleMatch?.action_type ?? "custom";
  const params = ruleMatch?.params ?? { raw_query: queryStr };
  const offers = findOffers(actionType, protocolRegistry);

  return {
    action_type: actionType,
    params,
    confidence: 0.9,
    resolver_type: "ai",
    offers,
  };
}

/* -------------------------------------------------------------------------- */
/*  Rate-limit                                                                */
/* -------------------------------------------------------------------------- */

// Token-bucket for Gemini throughput. When the bucket is empty, resolveIntent
// short-circuits to the rules path without attempting the AI call. Bucket
// refills at DISCOVERY_LLM_MAX_RPS tokens/sec, capped at the same value so
// short bursts get a boost without runaway. Module-scope state is fine — a
// single Fastify process is the granularity we rate-limit at.
const aiBucket = (() => {
  const max = config.DISCOVERY_LLM_MAX_RPS;
  let tokens = max;
  let lastRefill = Date.now();
  return {
    tryConsume(): boolean {
      const now = Date.now();
      const elapsedSec = (now - lastRefill) / 1000;
      tokens = Math.min(max, tokens + elapsedSec * max);
      lastRefill = now;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
})();

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function resolveIntent(
  queryStr: string,
  userWallet: string,
  protocolRegistry: Protocol[],
): Promise<IntentResult> {
  // Prefer AI path when configured AND rate-limit has capacity. On AI failure
  // (thrown error, timeout, etc.) we fall through to rules rather than
  // surfacing the error — the resolver must remain functional even if Gemini
  // is down. Callers see `resolver_type: "rules"` to observe the fallback.
  if (config.GEMINI_API_KEY && aiBucket.tryConsume()) {
    try {
      return await resolveWithAI(queryStr, userWallet, protocolRegistry);
    } catch {
      // Intentional suppression — fall through to rules.
    }
  }

  // Rules-based fallback — also taken when: no Gemini key, rate-limited, or
  // AI path threw above.
  const match = matchRules(queryStr);

  if (!match) {
    return {
      action_type: "custom",
      params: { raw_query: queryStr },
      confidence: 0.3,
      resolver_type: "rules",
      offers: [],
    };
  }

  const offers = findOffers(match.action_type, protocolRegistry);

  return {
    action_type: match.action_type,
    params: match.params,
    confidence: 0.7,
    resolver_type: "rules",
    offers,
  };
}
