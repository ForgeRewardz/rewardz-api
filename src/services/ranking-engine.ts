/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface RankableOffer {
  protocol_id: string;
  action_type: string;
  points: number;
  trust_score: number;
  campaign_id?: string;
}

export interface RankedOffer extends RankableOffer {
  placement_score: number;
  rank: number;
}

/* -------------------------------------------------------------------------- */
/*  Relevance factor                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute a relevance factor for an offer.
 *
 * - 1.0 for exact match (offer has a campaign_id, meaning it's a direct campaign hit)
 * - 0.8 for category match (no campaign, but action type was requested)
 * - 0.5 fallback
 *
 * In practice the calling code passes offers that already match the intent,
 * so we use the presence of campaign_id as the primary signal.
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
  return offer.points * trustNormalized * relevanceFactor(offer);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rank a set of offers by placement score.
 *
 * @param offers  The candidate offers to rank
 * @param _userWallet  Reserved for future per-user personalisation
 * @returns  Offers sorted descending by placement_score with rank assigned
 */
export function rankOffers(
  offers: RankableOffer[],
  _userWallet?: string,
): RankedOffer[] {
  const scored: RankedOffer[] = offers.map((o) => ({
    ...o,
    placement_score: score(o),
    rank: 0, // placeholder, assigned below
  }));

  scored.sort((a, b) => b.placement_score - a.placement_score);

  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }

  return scored;
}
