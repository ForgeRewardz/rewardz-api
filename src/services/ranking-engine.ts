/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type Visibility = "active" | "at_risk" | "hidden";

export interface RankableOffer {
  protocol_id: string;
  action_type: string;
  points: number;
  trust_score: number;
  campaign_id?: string;
  /** Protocol-level quality score in [0, 1] from the league hourly cron. */
  quality_score?: number;
  /** League visibility state. Hidden offers are dropped; at_risk are dampened. */
  visibility?: Visibility;
}

export interface RankedOffer extends RankableOffer {
  placement_score: number;
  rank: number;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Multiplier applied to at_risk protocols' placement_score so they sink in
 * the ranking but remain discoverable. league-config.md §Visibility names
 * "down-rank `at_risk`" without specifying a coefficient — 0.5 keeps them
 * present but well below an otherwise-equal active protocol.
 *
 * Exported so /discovery/featured (routes/discovery.ts) can interpolate
 * the same value into its SQL — a single source of truth prevents
 * silent drift between the app-side rankOffers() and the DB-side
 * discovery surface.
 */
export const AT_RISK_DAMPENER = 0.5;

/**
 * Additive placement boost applied to protocols flagged `featured=true`
 * in the latest league leaderboard snapshot. Used by /discovery/featured
 * so yesterday's leaderboard winners surface first. Exported alongside
 * AT_RISK_DAMPENER so the two ranking levers live together.
 */
export const FEATURED_BOOST = 0.1;

/**
 * Default for missing quality_score: treat as a neutral 0.5 rather than 0
 * (which would zero-out otherwise-strong offers from protocols that haven't
 * been scored yet) or 1.0 (which would unfairly boost unscored protocols
 * over scored ones). This matches the legacy DEFAULT 0.5 in protocols.
 */
const DEFAULT_QUALITY_SCORE = 0.5;

/* -------------------------------------------------------------------------- */
/*  Relevance factor                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute a relevance factor for an offer.
 *
 * - 1.0 for exact match (offer has a campaign_id, meaning it's a direct campaign hit)
 * - 0.8 for category match (no campaign, but action type was requested)
 * - 0.5 fallback
 */
function relevanceFactor(offer: RankableOffer): number {
  if (offer.campaign_id) return 1.0;
  if (offer.points > 0) return 0.8;
  return 0.5;
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

function score(offer: RankableOffer): number {
  const trustNormalized = offer.trust_score / 10_000;
  const quality = offer.quality_score ?? DEFAULT_QUALITY_SCORE;
  const visibilityFactor =
    offer.visibility === "at_risk" ? AT_RISK_DAMPENER : 1.0;
  return (
    offer.points *
    trustNormalized *
    relevanceFactor(offer) *
    quality *
    visibilityFactor
  );
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rank a set of offers by placement score.
 *
 * League rules (per league-config.md §Visibility):
 *   - `hidden` protocols are excluded entirely from the result.
 *   - `at_risk` protocols are kept but their score is multiplied by
 *     AT_RISK_DAMPENER so they sink behind comparable active protocols.
 *   - `active` (or undefined) protocols rank normally.
 *
 * Quality score (when present) is folded multiplicatively into the score
 * so a 0.4-quality protocol's offers are intrinsically less promoted than
 * a 0.9-quality one with otherwise-identical fields.
 *
 * @param offers       Candidate offers to rank
 * @param _userWallet  Reserved for future per-user personalisation
 * @returns            Visible offers sorted descending by placement_score with rank assigned
 */
export function rankOffers(
  offers: RankableOffer[],
  _userWallet?: string,
): RankedOffer[] {
  const visible = offers.filter((o) => o.visibility !== "hidden");

  const scored: RankedOffer[] = visible.map((o) => ({
    ...o,
    placement_score: score(o),
    rank: 0,
  }));

  scored.sort((a, b) => b.placement_score - a.placement_score);

  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }

  return scored;
}
