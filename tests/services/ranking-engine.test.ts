import { describe, expect, it } from "vitest";
import {
  rankOffers,
  type RankableOffer,
} from "../../src/services/ranking-engine.js";

const baseOffer: Omit<RankableOffer, "protocol_id" | "campaign_id"> = {
  action_type: "follow",
  points: 100,
  trust_score: 5_000,
};

describe("rankOffers — visibility filter", () => {
  it("excludes hidden offers entirely", () => {
    const ranked = rankOffers([
      {
        ...baseOffer,
        protocol_id: "p1",
        campaign_id: "c1",
        visibility: "active",
      },
      {
        ...baseOffer,
        protocol_id: "p2",
        campaign_id: "c2",
        visibility: "hidden",
      },
      {
        ...baseOffer,
        protocol_id: "p3",
        campaign_id: "c3",
        visibility: "at_risk",
      },
    ]);

    expect(ranked.map((r) => r.protocol_id)).toEqual(["p1", "p3"]);
    expect(ranked.find((r) => r.protocol_id === "p2")).toBeUndefined();
  });

  it("dampens at_risk offers below otherwise-equal active offers", () => {
    const ranked = rankOffers([
      {
        ...baseOffer,
        protocol_id: "active-protocol",
        campaign_id: "c-active",
        visibility: "active",
        quality_score: 0.8,
      },
      {
        ...baseOffer,
        protocol_id: "at-risk-protocol",
        campaign_id: "c-at-risk",
        visibility: "at_risk",
        quality_score: 0.8,
      },
    ]);

    expect(ranked[0].protocol_id).toBe("active-protocol");
    expect(ranked[1].protocol_id).toBe("at-risk-protocol");
    expect(ranked[1].placement_score).toBeLessThan(ranked[0].placement_score);
  });

  it("treats undefined visibility as active (backwards-compatible)", () => {
    const ranked = rankOffers([
      { ...baseOffer, protocol_id: "p-undef", campaign_id: "c1" },
      {
        ...baseOffer,
        protocol_id: "p-active",
        campaign_id: "c2",
        visibility: "active",
      },
    ]);

    expect(ranked).toHaveLength(2);
    // Undefined and active should produce identical placement_score.
    expect(ranked[0].placement_score).toBe(ranked[1].placement_score);
  });
});

describe("rankOffers — quality_score weighting", () => {
  it("ranks higher quality_score above lower for otherwise-identical offers", () => {
    const ranked = rankOffers([
      {
        ...baseOffer,
        protocol_id: "low-q",
        campaign_id: "c1",
        quality_score: 0.3,
      },
      {
        ...baseOffer,
        protocol_id: "high-q",
        campaign_id: "c2",
        quality_score: 0.9,
      },
    ]);

    expect(ranked[0].protocol_id).toBe("high-q");
    expect(ranked[1].protocol_id).toBe("low-q");
  });

  it("uses 0.5 default when quality_score is absent", () => {
    const [withDefault] = rankOffers([
      { ...baseOffer, protocol_id: "p", campaign_id: "c" },
    ]);
    const [withExplicit] = rankOffers([
      { ...baseOffer, protocol_id: "p", campaign_id: "c", quality_score: 0.5 },
    ]);

    expect(withDefault.placement_score).toBe(withExplicit.placement_score);
  });
});

describe("rankOffers — rank assignment", () => {
  it("assigns ranks 1..N to visible offers in score order", () => {
    const ranked = rankOffers([
      {
        ...baseOffer,
        protocol_id: "p1",
        campaign_id: "c1",
        quality_score: 0.5,
      },
      {
        ...baseOffer,
        protocol_id: "p2",
        campaign_id: "c2",
        quality_score: 0.9,
      },
      {
        ...baseOffer,
        protocol_id: "p3",
        campaign_id: "c3",
        visibility: "hidden",
      },
      {
        ...baseOffer,
        protocol_id: "p4",
        campaign_id: "c4",
        quality_score: 0.7,
      },
    ]);

    expect(ranked.map((r) => ({ id: r.protocol_id, rank: r.rank }))).toEqual([
      { id: "p2", rank: 1 },
      { id: "p4", rank: 2 },
      { id: "p1", rank: 3 },
    ]);
  });
});
