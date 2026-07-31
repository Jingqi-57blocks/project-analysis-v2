import { describe, expect, it } from "vitest";

import { MIGRATION_MATRIX } from "../../../engine/contracts/migration/matrix.js";
import { M2_FACT_KINDS, TERMINOLOGY, validateMatrix } from "../../../engine/contracts/migration/schema.js";

const matrix = MIGRATION_MATRIX;

describe("provider migration matrix", () => {
  it("validates structurally", () => {
    const result = validateMatrix(matrix);
    expect(result.ok, result.ok ? "" : result.reasons.join("; ")).toBe(true);
  });

  it("gives every unit exactly one home and unique id", () => {
    const ids = matrix.units.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const unit of matrix.units) {
      expect(["retain", "adapt", "enricher", "test-only", "net-new", "remove"], unit.id).toContain(unit.home);
    }
  });

  it("accounts for every M2 fact kind", () => {
    for (const kind of M2_FACT_KINDS) {
      const covered = matrix.units.some((u) => u.factKinds.includes(kind));
      expect(covered, `${kind} maps to no unit`).toBe(true);
    }
  });

  it("marks state and transition net-new, with no existing emitter", () => {
    const stateUnit = matrix.units.find((u) => u.factKinds.includes("state"));
    expect(stateUnit?.home).toBe("net-new");
    expect(matrix.units.filter((u) => u.factKinds.includes("state") && u.home !== "net-new")).toHaveLength(0);
  });

  it("keeps the test-relation unit present but unregistered", () => {
    const testUnit = matrix.units.find((u) => u.factKinds.includes("test-relation"));
    expect(testUnit).toBeDefined();
    expect(testUnit!.registered).toBe(false);
    expect(testUnit!.action).toBe("integrate");
  });

  it("downgrades framework routes to an enricher and keeps conventions heuristic", () => {
    expect(matrix.units.find((u) => u.id === "frameworkroutes")?.home).toBe("enricher");
    expect(matrix.units.find((u) => u.id === "conventions")?.home).toBe("enricher");
  });

  it("marks fake as test-only and never registered", () => {
    const fake = matrix.units.find((u) => u.id === "fake");
    expect(fake?.home).toBe("test-only");
    expect(fake?.registered).toBe(false);
  });

  it("defines the full role terminology", () => {
    for (const role of ["provider", "deriver", "enricher", "collector", "parser", "test-provider"] as const) {
      expect(TERMINOLOGY[role].length).toBeGreaterThan(0);
    }
  });
});
