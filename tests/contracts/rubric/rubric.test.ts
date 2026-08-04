import { describe, expect, it } from "vitest";

import {
  evaluateGate,
  GATES,
  gatesForMilestone,
  GOLDEN_SLICE_THRESHOLDS,
  meetsThreshold,
} from "../../../engine/contracts/rubric/gates.js";

describe("gates", () => {
  it("every gate names an artifact, formula, thresholds, failure code and owner", () => {
    const ids = new Set<string>();
    for (const gate of GATES) {
      expect(ids.has(gate.id)).toBe(false);
      ids.add(gate.id);
      expect(gate.inputArtifact.length).toBeGreaterThan(0);
      expect(gate.formula.length).toBeGreaterThan(0);
      expect(gate.failureCode.length).toBeGreaterThan(0);
      expect(gate.owner.length).toBeGreaterThan(0);
      expect(gate.thresholds.length).toBeGreaterThan(0);
    }
  });

  it("fixes the golden-slice hard thresholds on the M4 and M6 gates", () => {
    for (const id of ["M4-fresh-run-golden", "M6-release"]) {
      const gate = GATES.find((g) => g.id === id)!;
      const metrics = gate.thresholds.map((t) => t.metric);
      expect(metrics).toContain("must_find_ratio");
      expect(metrics).toContain("must_print_ratio");
      expect(metrics).toContain("known_wrong");
    }
    expect(GOLDEN_SLICE_THRESHOLDS.find((t) => t.metric === "must_find_ratio")).toEqual({
      metric: "must_find_ratio",
      comparator: "==",
      value: 1,
    });
  });

  it("evaluates objectively: a met set passes, an unmet or missing metric fails", () => {
    const gate = gatesForMilestone("M1").find((g) => g.id === "M1-structure-golden")!;
    const pass = evaluateGate(gate, {
      must_find_ratio: 1,
      critical_unresolved: 0,
      required_codegraph_lane_available: 1,
    });
    expect(pass.passed).toBe(true);
    const fail = evaluateGate(gate, { must_find_ratio: 0.99, critical_unresolved: 0, required_codegraph_lane_available: 1 });
    expect(fail.passed).toBe(false);
    const missing = evaluateGate(gate, { must_find_ratio: 1 });
    expect(missing.passed).toBe(false);
  });

  it("meetsThreshold honors the comparator", () => {
    expect(meetsThreshold({ metric: "x", comparator: "==", value: 0 }, 0)).toBe(true);
    expect(meetsThreshold({ metric: "x", comparator: ">=", value: 1 }, 1)).toBe(true);
    expect(meetsThreshold({ metric: "x", comparator: "<=", value: 0 }, 1)).toBe(false);
  });
});
