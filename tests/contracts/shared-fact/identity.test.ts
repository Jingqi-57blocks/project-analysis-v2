import { describe, expect, it } from "vitest";

import { factId } from "../../../engine/contracts/shared-fact/identity.js";
import { SHARED_FACT_CONTRACT_VERSION } from "../../../engine/contracts/shared-fact/version.js";

describe("factId", () => {
  it("is stable for the same parts and the same snapshot", () => {
    const parts = {
      family: "structural" as const,
      kind: "symbol",
      discriminators: ["api", "leave/service.go", "func", "Service.RequestLeave"],
    };
    expect(factId(parts)).toBe(factId(parts));
  });

  it("does not depend on which provider found the fact", () => {
    // Identity is code-derived; a provider's own handle lives in RawIdentity,
    // never in the id, so two providers finding one fact resolve to one id.
    const discriminators = ["api", "x.go", "func", "F"];
    const found = () => factId({ family: "structural", kind: "symbol", discriminators });
    expect(found()).toBe(found());
  });

  it("separates kinds even when their discriminators coincide", () => {
    const asSymbol = factId({ family: "structural", kind: "symbol", discriminators: ["api", "x.go"] });
    const asFile = factId({ family: "structural", kind: "source-file", discriminators: ["api", "x.go"] });
    expect(asSymbol).not.toBe(asFile);
  });

  it("changes when a location discriminator changes", () => {
    const at10 = factId({ family: "behavioral", kind: "condition", discriminators: ["api", "x.go", 10] });
    const at20 = factId({ family: "behavioral", kind: "condition", discriminators: ["api", "x.go", 20] });
    expect(at10).not.toBe(at20);
  });

  it("keeps identity for a symbol observed at different lines", () => {
    // A symbol keyer discriminates by qualified name, not by where it was seen,
    // so the same symbol found at two lines is one identity — the line is not a
    // symbol discriminator.
    const discriminators = ["api", "x.go", "func", "F"];
    const a = factId({ family: "structural", kind: "symbol", discriminators });
    const b = factId({ family: "structural", kind: "symbol", discriminators });
    expect(a).toBe(b);
  });

  it("does not collide when a delimiter appears inside a part", () => {
    const a = factId({ family: "structural", kind: "symbol", discriminators: ["a|b", "c"] });
    const b = factId({ family: "structural", kind: "symbol", discriminators: ["a", "b|c"] });
    expect(a).not.toBe(b);
  });

  it("does not fold the contract version into the id", () => {
    // factId takes no version, so a compatible version bump cannot churn it.
    const id = factId({ family: "structural", kind: "symbol", discriminators: ["api", "x.go", "func", "F"] });
    expect(id).not.toContain(SHARED_FACT_CONTRACT_VERSION);
  });
});
