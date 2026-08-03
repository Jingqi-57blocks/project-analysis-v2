import { describe, expect, it } from "vitest";

import {
  bucketOf,
  classifyCoverage,
  countsTowardDenominator,
  COVERAGE_STATES,
  type CoverageInput,
  type CoverageState,
  gapKindOf,
  sectionApplicabilityOf,
} from "../../../engine/contracts/shared-fact/applicability.js";

/** A fully-determined "found" slot; each test flips one flag off the baseline. */
const found: CoverageInput = {
  capable: true,
  providerRan: true,
  scopeDefined: true,
  evidencePresent: true,
  notApplicableConfirmed: false,
  failed: false,
  truncated: false,
  conflict: false,
};

describe("classifyCoverage", () => {
  it("classifies a completed run with evidence as found, without as not-found", () => {
    expect(classifyCoverage(found).state).toBe("found");
    expect(classifyCoverage({ ...found, evidencePresent: false }).state).toBe("not-found");
  });

  it("fails closed to unknown on conflict, no run, or undefined scope", () => {
    expect(classifyCoverage({ ...found, conflict: true }).state).toBe("unknown");
    expect(classifyCoverage({ ...found, providerRan: false }).state).toBe("unknown");
    expect(classifyCoverage({ ...found, scopeDefined: false }).state).toBe("unknown");
  });

  it("never records a broken, cut-off, or unsupported attempt as not-applicable", () => {
    const naConfirmed = { ...found, notApplicableConfirmed: true, evidencePresent: false };
    expect(classifyCoverage({ ...naConfirmed, failed: true }).state).toBe("failed");
    expect(classifyCoverage({ ...naConfirmed, truncated: true }).state).toBe("truncated");
    expect(classifyCoverage({ ...naConfirmed, capable: false }).state).toBe("unsupported");
  });

  it("records a confirmed inapplicable scope as not-applicable", () => {
    expect(
      classifyCoverage({ ...found, notApplicableConfirmed: true, evidencePresent: false }).state,
    ).toBe("not-applicable");
  });

  it("gives every state a non-empty reason and a known code", () => {
    for (const input of allInputs()) {
      const { state, reason } = classifyCoverage(input);
      expect(COVERAGE_STATES).toContain(state);
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("holds the acceptance invariants across all 256 input combinations", () => {
    for (const input of allInputs()) {
      const { state } = classifyCoverage(input);
      // unsupported / failed / truncated are never re-read as not-applicable.
      if (input.failed || input.truncated || !input.capable) {
        expect(state).not.toBe("not-applicable");
      }
      // not-found only when the provider ran over a defined scope, no conflict,
      // capable, not confirmed inapplicable, and genuinely no evidence.
      if (state === "not-found") {
        expect(input.capable && input.providerRan && input.scopeDefined).toBe(true);
        expect(input.conflict || input.failed || input.truncated).toBe(false);
        expect(input.notApplicableConfirmed || input.evidencePresent).toBe(false);
      }
    }
  });
});

describe("projections", () => {
  it("maps a definite empty to an included section, and gaps to unknown", () => {
    expect(sectionApplicabilityOf("found")).toBe("included");
    expect(sectionApplicabilityOf("not-found")).toBe("included");
    expect(sectionApplicabilityOf("not-applicable")).toBe("not-applicable");
    for (const s of ["unknown", "unsupported", "failed", "truncated"] as const) {
      expect(sectionApplicabilityOf(s)).toBe("unknown");
    }
  });

  it("names a capability gap for unsupported and an evidence gap for the rest", () => {
    expect(gapKindOf("unsupported")).toBe("capability");
    for (const s of ["unknown", "failed", "truncated"] as const) {
      expect(gapKindOf(s)).toBe("evidence");
    }
    for (const s of ["found", "not-found", "not-applicable"] as const) {
      expect(gapKindOf(s)).toBeNull();
    }
  });

  it("counts every bucket toward the denominator except not-applicable", () => {
    for (const state of COVERAGE_STATES) {
      const inDenom = countsTowardDenominator(bucketOf(state));
      expect(inDenom).toBe(state !== "not-applicable");
    }
  });

  it("maps each coverage state to exactly one bucket", () => {
    const seen = new Map<string, CoverageState>();
    for (const state of COVERAGE_STATES) {
      const bucket = bucketOf(state);
      expect(seen.has(bucket)).toBe(false);
      seen.set(bucket, state);
    }
  });
});

function allInputs(): CoverageInput[] {
  const flags: readonly (keyof CoverageInput)[] = [
    "capable",
    "providerRan",
    "scopeDefined",
    "evidencePresent",
    "notApplicableConfirmed",
    "failed",
    "truncated",
    "conflict",
  ];
  const inputs: CoverageInput[] = [];
  for (let mask = 0; mask < 1 << flags.length; mask++) {
    const obj: Record<string, boolean> = {};
    flags.forEach((flag, index) => {
      obj[flag] = (mask & (1 << index)) !== 0;
    });
    inputs.push(obj as unknown as CoverageInput);
  }
  return inputs;
}
