import { describe, expect, it } from "vitest";

import {
  CONDITIONAL_KINDS,
  STRUCTURAL_KINDS,
  UNIVERSAL_KINDS,
  countRecords,
  emptyRecords,
  isUniversalKind,
} from "../../engine/structural/kinds.js";

describe("the kind registry", () => {
  it("splits every kind into exactly one of universal or conditional", () => {
    const universal = new Set<string>(UNIVERSAL_KINDS);
    const conditional = new Set<string>(CONDITIONAL_KINDS);

    for (const kind of STRUCTURAL_KINDS) {
      const inUniversal = universal.has(kind);
      const inConditional = conditional.has(kind);
      expect(inUniversal !== inConditional, `${kind} must be in exactly one group`).toBe(true);
    }
  });

  it("has no duplicate kinds", () => {
    expect(new Set(STRUCTURAL_KINDS).size).toBe(STRUCTURAL_KINDS.length);
  });

  it("gives every declared kind a bucket, with no bucket left over", () => {
    // The compile-time check in kinds.ts already proves this, and adding a
    // kind without a bucket fails to typecheck with the kind named. This
    // asserts the same thing at runtime so the guarantee survives anyone
    // silencing the type error.
    const records = emptyRecords();
    expect(Object.keys(records).sort()).toEqual([...STRUCTURAL_KINDS].sort());
  });

  it("treats routes as conditional, so a library reporting none is not a finding", () => {
    // The concrete reason this split exists: a project type neither registered
    // target represents must not look broken.
    expect(isUniversalKind("route")).toBe(false);
    expect(isUniversalKind("data-access")).toBe(false);
    expect(isUniversalKind("outbound-call")).toBe(false);
  });

  it("treats symbols as universal, so an empty result is weak evidence of a gap", () => {
    expect(isUniversalKind("symbol")).toBe(true);
    expect(isUniversalKind("source-file")).toBe(true);
  });

  it("treats package dependencies as conditional — a project may have no package manager", () => {
    expect(isUniversalKind("package-dependency")).toBe(false);
    expect(isUniversalKind("build-target")).toBe(false);
  });
});

describe("emptyRecords", () => {
  it("starts every bucket empty", () => {
    const records = emptyRecords();
    for (const kind of STRUCTURAL_KINDS) {
      expect(records[kind], `${kind} should start empty`).toEqual([]);
    }
    expect(countRecords(records)).toBe(0);
  });

  it("returns a fresh object each call, so one contribution cannot leak into another", () => {
    expect(emptyRecords()).not.toBe(emptyRecords());
  });
});

describe("countRecords", () => {
  it("totals across every bucket", () => {
    const records = {
      ...emptyRecords(),
      symbol: [{}, {}],
      route: [{}],
    } as unknown as ReturnType<typeof emptyRecords>;

    expect(countRecords(records)).toBe(3);
  });
});
