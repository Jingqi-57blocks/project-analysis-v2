import { describe, expect, it } from "vitest";

import { aggregateConfidence, CONFIDENCE_LEVELS } from "../../../engine/contracts/shared-fact/confidence.js";

describe("aggregateConfidence", () => {
  it("is null for an empty set — no basis", () => {
    expect(aggregateConfidence([])).toBeNull();
  });

  it("keeps a uniform level", () => {
    expect(aggregateConfidence(["high", "high"])).toBe("high");
    expect(aggregateConfidence(["low"])).toBe("low");
  });

  it("weakens to the least confident member, never strengthens", () => {
    expect(aggregateConfidence(["high", "low"])).toBe("low");
    expect(aggregateConfidence(["high", "medium"])).toBe("medium");
    expect(aggregateConfidence(["medium", "low", "high"])).toBe("low");
  });

  it("exposes the three levels", () => {
    expect(CONFIDENCE_LEVELS).toEqual(["high", "medium", "low"]);
  });
});
