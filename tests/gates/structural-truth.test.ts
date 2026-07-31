import { describe, expect, it } from "vitest";

import type { ImportedEdge } from "../../engine/providers/codegraph/importedges.js";
import type { ImportedNode } from "../../engine/providers/codegraph/importnodes.js";
import type { TruthItem } from "../../engine/contracts/truth/schema.js";
import { gradeStructuralTruth } from "../../engine/gates/structural-truth.js";

const node = (path: string): ImportedNode => ({
  nativeId: path,
  structuralKind: "symbol",
  rawKind: "function",
  name: "x",
  qualifiedName: null,
  filePath: path,
  startLine: 1,
  endLine: 2,
  metadata: {},
});

function item(id: string, category: string, criticality: "critical" | "normal", path: string, root = "wcp-service-v2"): TruthItem {
  return {
    id,
    facets: ["M1"],
    category,
    claim: "",
    evidence: [{ root, path }],
    expectedResolution: "observed",
    expectedStatus: "found",
    criticality,
    mustFind: true,
    mustPrint: false,
    requiredScope: ["module"],
    requiredAudience: ["developer"],
  };
}

const noEdges: readonly ImportedEdge[] = [];

describe("gradeStructuralTruth", () => {
  it("finds an entry-point when a node exists at the cited file", () => {
    const report = gradeStructuralTruth(
      [item("EP1", "entry-point", "critical", "internal/handlers/leave/router.go")],
      [node("internal/handlers/leave/router.go")],
      noEdges,
      "wcp-service-v2",
    );
    expect(report.results[0]!.status).toBe("found");
    expect(report.passed).toBe(true);
    expect(report.mustFindFound).toBe(1);
  });

  it("marks a critical item not-found when there is no structure at the cited file, and fails the gate", () => {
    const report = gradeStructuralTruth(
      [item("EP1", "entry-point", "critical", "internal/handlers/leave/router.go")],
      [node("other.go")],
      noEdges,
      "wcp-service-v2",
    );
    expect(report.results[0]!.status).toBe("not-found");
    expect(report.criticalIssues).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("marks db-table and cross-repo unsupported by the CodeGraph lane, with attribution", () => {
    const report = gradeStructuralTruth(
      [item("TBL", "db-table", "normal", "internal/model/leave.go"), item("XR", "cross-repo", "normal", "internal/x.go")],
      [],
      noEdges,
      "wcp-service-v2",
    );
    expect(report.results.every((r) => r.status === "unsupported")).toBe(true);
    expect(report.results[0]!.detail).toContain("datamodel");
    // Unsupported items are not counted against the CodeGraph must-find, so the
    // gate is not failed by facts another lane owns.
    expect(report.mustFindTotal).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("marks evidence in another root unresolved", () => {
    const uiItem = item("UI", "call-edge", "normal", "src/x.ts", "wcp-ui");
    const report = gradeStructuralTruth([uiItem], [], noEdges, "wcp-service-v2");
    expect(report.results[0]!.status).toBe("unresolved");
  });
});
