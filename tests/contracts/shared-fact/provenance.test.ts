import { describe, expect, it } from "vitest";

import { INVALID_PROVENANCE_EXAMPLES } from "../../../engine/contracts/shared-fact/examples.js";
import {
  declared,
  inferred,
  isDirectlyObserved,
  isLegalResolutionTransition,
  lineRef,
  offsetRef,
  resolved,
  unresolved,
  validateProvenance,
} from "../../../engine/contracts/shared-fact/provenance.js";

const src = lineRef("api", "x.go", 1);

describe("validateProvenance", () => {
  it("accepts each well-formed resolution class", () => {
    expect(validateProvenance(declared(src)).ok).toBe(true);
    expect(validateProvenance(resolved(src, "high")).ok).toBe(true);
    expect(validateProvenance(resolved(src, null)).ok).toBe(true);
    expect(validateProvenance(inferred(src, "low")).ok).toBe(true);
    expect(validateProvenance(unresolved(src, "dynamic target")).ok).toBe(true);
  });

  it("rejects confidence standing in for resolution, and other cross-substitutions", () => {
    for (const example of INVALID_PROVENANCE_EXAMPLES) {
      expect(validateProvenance(example.value).ok, example.why).toBe(false);
    }
  });
});

describe("isDirectlyObserved", () => {
  it("is true for declared and resolved, false for inferred and unresolved", () => {
    expect(isDirectlyObserved(declared(src))).toBe(true);
    expect(isDirectlyObserved(resolved(src, "high"))).toBe(true);
    expect(isDirectlyObserved(inferred(src, "high"))).toBe(false);
    expect(isDirectlyObserved(unresolved(src, "why"))).toBe(false);
  });
});

describe("isLegalResolutionTransition", () => {
  it("allows strengthening and same-class, forbids weakening", () => {
    expect(isLegalResolutionTransition("unresolved", "resolved")).toBe(true);
    expect(isLegalResolutionTransition("inferred", "declared")).toBe(true);
    expect(isLegalResolutionTransition("resolved", "resolved")).toBe(true);
    expect(isLegalResolutionTransition("declared", "unresolved")).toBe(false);
    expect(isLegalResolutionTransition("resolved", "inferred")).toBe(false);
  });
});

describe("offsetRef", () => {
  it("gives two facts on one line distinct columns", () => {
    const content = "a := 1; b := 2\n";
    const first = offsetRef("api", "x.go", content, 0);
    const second = offsetRef("api", "x.go", content, content.indexOf("b"));
    expect(first.startLine).toBe(1);
    expect(second.startLine).toBe(1);
    expect(first.startColumn).not.toBe(second.startColumn);
  });
});
