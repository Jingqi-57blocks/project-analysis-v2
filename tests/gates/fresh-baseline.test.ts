import { describe, expect, it } from "vitest";

import type { TruthItem } from "../../engine/contracts/truth/schema.js";
import type { StructuralGateReport } from "../../engine/gates/structural-truth.js";
import type { BehaviorGateReport } from "../../engine/gates/behavior-truth.js";
import type { ReportGateReport } from "../../engine/gates/report-truth.js";
import { aggregateFreshBaseline, type RunManifest } from "../../engine/gates/fresh-baseline.js";

function item(id: string, facets: TruthItem["facets"], criticality: "critical" | "normal" = "normal"): TruthItem {
  return {
    id,
    facets,
    category: "x",
    claim: "c",
    evidence: [{ root: "wcp-service-v2", path: "a.go" }],
    expectedResolution: "observed",
    expectedStatus: "found",
    criticality,
    mustFind: criticality === "critical",
    mustPrint: false,
    requiredScope: ["module"],
    requiredAudience: ["product"],
  };
}

function structural(results: { truthId: string; status: StructuralGateReport["results"][number]["status"] }[]): StructuralGateReport {
  return {
    indexedRoot: "wcp-service-v2",
    total: results.length,
    results: results.map((r) => ({ truthId: r.truthId, category: "x", criticality: "normal", mustFind: false, status: r.status, detail: r.status })),
    counts: { found: 0, "not-found": 0, unresolved: 0, unsupported: 0, failed: 0, truncated: 0 },
    mustFindTotal: 0,
    mustFindFound: 0,
    criticalIssues: 0,
    passed: true,
  };
}

function behavior(results: { truthId: string; status: StructuralGateReport["results"][number]["status"] }[]): BehaviorGateReport {
  return {
    indexedRoot: "wcp-service-v2",
    total: results.length,
    results: results.map((r) => ({ truthId: r.truthId, category: "x", criticality: "normal", mustFind: false, lane: "other" as const, status: r.status, detail: r.status })),
    counts: { found: 0, "not-found": 0, unresolved: 0, unsupported: 0, failed: 0, truncated: 0 },
    mustFindTotal: 0,
    mustFindFound: 0,
    criticalIssues: 0,
    denominator: 0,
    ownershipDisjoint: true,
    passed: true,
  };
}

function report(results: { truthId: string; status: ReportGateReport["results"][number]["status"] }[]): ReportGateReport {
  return {
    documentIds: ["module:leave|developer", "module:leave|product"],
    total: results.length,
    results: results.map((r) => ({
      truthId: r.truthId,
      category: "x",
      criticality: "normal",
      mustPrint: false,
      mustFind: false,
      requiredScope: ["module"],
      requiredAudience: ["product"],
      status: r.status,
      placements: [],
      detail: r.status,
    })),
    counts: { printed: 0, counted: 0, omitted: 0, "not-applicable": 0, unknown: 0, unsupported: 0, missing: 0 },
    mustPrintTotal: 0,
    mustPrintPrinted: 0,
    sliceOutClaims: 0,
    crossReportConflicts: 0,
    criticalIssues: 0,
    passed: true,
  };
}

const MANIFEST: RunManifest = {
  snapshotIdentity: "snap-1",
  analysisSnapshotId: 1,
  behaviorSnapshotId: 1,
  codeIndexNodeCount: 100,
  truthVersion: "0.1.0",
  pipelineVersion: "1.0.0",
  structuralRoot: "wcp-service-v2",
  rootRevisions: [{ name: "wcp-service-v2", commitSha: "7db2ee8d", dirty: false }],
  reportDocuments: ["module:leave|developer", "module:leave|product"],
  gatesGradedThisRun: true,
};

describe("aggregateFreshBaseline — layered attribution", () => {
  it("attributes a gap to the earliest layer that failed", () => {
    const items = [
      item("A-struct-miss", ["M1", "M2", "M3"]),
      item("B-deriver-miss", ["M1", "M2", "M3"]),
      item("C-report-miss", ["M1", "M2", "M3"]),
      item("D-printed", ["M1", "M2", "M3"]),
    ];
    const s = structural([
      { truthId: "A-struct-miss", status: "not-found" }, // fails at codegraph
      { truthId: "B-deriver-miss", status: "found" },
      { truthId: "C-report-miss", status: "found" },
      { truthId: "D-printed", status: "found" },
    ]);
    const b = behavior([
      { truthId: "B-deriver-miss", status: "not-found" }, // found structurally, missing in behaviour → deriver
      { truthId: "C-report-miss", status: "found" },
      { truthId: "D-printed", status: "found" },
    ]);
    const r = report([
      { truthId: "C-report-miss", status: "missing" }, // derived but not printed → report
      { truthId: "D-printed", status: "printed" },
    ]);

    const baseline = aggregateFreshBaseline({ truthItems: items, structural: s, behavior: b, report: r, manifest: MANIFEST, projectLevelDocuments: 0, projectLevelTasks: 0 });
    const byId = new Map(baseline.dispositions.map((d) => [d.truthId, d]));

    expect(byId.get("A-struct-miss")).toMatchObject({ disposition: "missing", layer: "codegraph" });
    expect(byId.get("B-deriver-miss")).toMatchObject({ disposition: "missing", layer: "deriver" });
    expect(byId.get("C-report-miss")).toMatchObject({ disposition: "missing", layer: "report" });
    expect(byId.get("D-printed")).toMatchObject({ disposition: "printed", layer: "report" });
  });

  it("keeps an owning facet's verdict when a later facet disclaims the item (not its lane)", () => {
    // a role item: M1 (structural) owns and finds it; M2 (behaviour) disclaims it as
    // unsupported ("owned by the structural lane"). The disclaimer must not override
    // the found verdict — it stays observed @ codegraph, not unsupported @ deriver.
    const items = [item("T-ROLE-01", ["M1", "M2"], "critical")];
    const baseline = aggregateFreshBaseline({
      truthItems: items,
      structural: structural([{ truthId: "T-ROLE-01", status: "found" }]),
      behavior: behavior([{ truthId: "T-ROLE-01", status: "unsupported" }]),
      report: report([]),
      manifest: MANIFEST,
      projectLevelDocuments: 0,
      projectLevelTasks: 0,
    });
    expect(baseline.dispositions[0]).toMatchObject({ disposition: "observed", layer: "codegraph" });
    expect(baseline.gapLedger).toEqual([]); // not a phantom deriver gap
  });

  it("attributes an item every graded facet disclaims to no layer, not the disclaiming one", () => {
    // an object item: only M2, which disclaims it to the datamodel lane. It is an
    // honest gap, but blamed on no pipeline layer.
    const items = [item("T-OBJ-01", ["M2"], "normal")];
    const baseline = aggregateFreshBaseline({
      truthItems: items,
      structural: structural([]),
      behavior: behavior([{ truthId: "T-OBJ-01", status: "unsupported" }]),
      report: report([]),
      manifest: MANIFEST,
      projectLevelDocuments: 0,
      projectLevelTasks: 0,
    });
    expect(baseline.dispositions[0]).toMatchObject({ disposition: "unsupported", layer: "none" });
    expect(baseline.gapLedger.map((g) => g.truthId)).toEqual(["T-OBJ-01"]); // still an honest gap
  });

  it("conserves the total across the disposition buckets", () => {
    const items = [item("A", ["M1"]), item("B", ["M2"]), item("C", ["M3"])];
    const baseline = aggregateFreshBaseline({
      truthItems: items,
      structural: structural([{ truthId: "A", status: "found" }]),
      behavior: behavior([{ truthId: "B", status: "unresolved" }]),
      report: report([{ truthId: "C", status: "counted" }]),
      manifest: MANIFEST,
      projectLevelDocuments: 0,
      projectLevelTasks: 0,
    });
    expect(baseline.total).toBe(3);
    expect(Object.values(baseline.counts).reduce((a, b) => a + b, 0)).toBe(3);
    expect(baseline.counts.observed).toBe(1);
    expect(baseline.counts.unresolved).toBe(1);
    expect(baseline.counts.counted).toBe(1);
  });

  it("collects gaps most-critical first and passes only when footprint and identities hold", () => {
    const items = [item("crit", ["M2"], "critical"), item("norm", ["M2"], "normal")];
    const b = behavior([
      { truthId: "crit", status: "not-found" },
      { truthId: "norm", status: "not-found" },
    ]);
    const ok = aggregateFreshBaseline({ truthItems: items, structural: structural([]), behavior: b, report: report([]), manifest: MANIFEST, projectLevelDocuments: 0, projectLevelTasks: 0 });
    expect(ok.gapLedger.map((g) => g.truthId)).toEqual(["crit", "norm"]); // critical first
    expect(ok.wellFormed).toBe(true); // buckets conserve, footprint 0, identities match

    const projectLeak = aggregateFreshBaseline({ truthItems: items, structural: structural([]), behavior: b, report: report([]), manifest: MANIFEST, projectLevelDocuments: 1, projectLevelTasks: 0 });
    expect(projectLeak.wellFormed).toBe(false); // module-only request must have zero project documents

    const gatesDidNotGrade = aggregateFreshBaseline({ truthItems: items, structural: structural([]), behavior: b, report: report([]), manifest: { ...MANIFEST, gatesGradedThisRun: false }, projectLevelDocuments: 0, projectLevelTasks: 0 });
    expect(gatesDidNotGrade.wellFormed).toBe(false);
  });

  it("separates a well-formed measurement from a passing golden slice", () => {
    const items = [item("A", ["M2"], "critical")];
    // the measurement is valid, but a behaviour gate that did not pass means the
    // golden slice did not pass — the two must not be conflated.
    const behaviorFailed = { ...behavior([{ truthId: "A", status: "not-found" }]), passed: false };
    const baseline = aggregateFreshBaseline({ truthItems: items, structural: { ...structural([]), passed: true }, behavior: behaviorFailed, report: { ...report([]), passed: true }, manifest: MANIFEST, projectLevelDocuments: 0, projectLevelTasks: 0 });
    expect(baseline.wellFormed).toBe(true);
    expect(baseline.goldenSlicePassed).toBe(false); // a layer has an unclosed gap
  });

  it("is deterministic — same inputs, same digest", () => {
    const items = [item("A", ["M1"])];
    const args = { truthItems: items, structural: structural([{ truthId: "A", status: "found" as const }]), behavior: behavior([]), report: report([]), manifest: MANIFEST, projectLevelDocuments: 0, projectLevelTasks: 0 };
    expect(aggregateFreshBaseline(args).digest).toBe(aggregateFreshBaseline(args).digest);
  });
});
