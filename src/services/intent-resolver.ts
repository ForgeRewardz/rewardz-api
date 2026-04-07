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

function matchRules(queryStr: string): RuleMatch | null {
  const q = queryStr.trim().toLowerCase();

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
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function resolveIntent(
  queryStr: string,
  userWallet: string,
  protocolRegistry: Protocol[],
): Promise<IntentResult> {
  // Prefer AI path when configured
  if (config.GEMINI_API_KEY) {
    return resolveWithAI(queryStr, userWallet, protocolRegistry);
  }

  // Rules-based fallback
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
