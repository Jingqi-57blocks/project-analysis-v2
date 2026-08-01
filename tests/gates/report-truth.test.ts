import { describe, expect, it } from "vitest";

import { itemsForFacet, loadLeaveTruthLedger } from "../../engine/contracts/truth/leave.js";
import type { TruthItem } from "../../engine/contracts/truth/schema.js";
import type { GenerationParams } from "../../engine/contracts/report/pipeline.js";
import { authoredTasks } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { moduleTarget, type ReportRequest } from "../../engine/contracts/report/target.js";
import type { SectionDefinition } from "../../engine/contracts/report/catalog.js";
import type { CoverageInput } from "../../engine/contracts/shared-fact/applicability.js";
import type { KindCoverageInput } from "../../engine/report/applicability.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { gradeReportTruth } from "../../engine/gates/report-truth.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "wcp-v2-leave",
  codeGraphIdentity: "graph",
  providerIdentity: "providers",
  schemaVersion: "1.0.0",
  configIdentity: "config",
};
const PARAMS: GenerationParams = { executorKind: "host-agent", modelId: "m3", language: "en" };
const MODULE = "leave";

function cov(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    capable: true,
    providerRan: true,
    scopeDefined: true,
    evidencePresent: true,
    notApplicableConfirmed: false,
    failed: false,
    truncated: false,
    conflict: false,
    ...over,
  };
}

function compile(
  request: ReportRequest = [moduleTarget(MODULE, "product"), moduleTarget(MODULE, "developer")],
  coverage?: (t: unknown, s: SectionDefinition) => readonly KindCoverageInput[],
) {
  return compileExecutablePlan({
    request,
    snapshot: SNAPSHOT,
    params: PARAMS,
    analysisRunId: "run-1",
    ...(coverage === undefined ? {} : { coverage: coverage as never }),
  });
}

const m3 = () => itemsForFacet(loadLeaveTruthLedger(), "M3");
const allValidated = (e: ReturnType<typeof compile>) => new Set(authoredTasks(e.plan).map((t) => t.taskId));

describe("gradeReportTruth — the golden-slice hard gate", () => {
  it("passes when every must-print item is printed in its required scope × audience", () => {
    const e = compile();
    const report = gradeReportTruth(m3(), e, allValidated(e), MODULE);
    expect(report.mustPrintTotal).toBe(8); // the eight critical notification facts
    expect(report.mustPrintPrinted).toBe(8);
    expect(report.criticalIssues).toBe(0);
    expect(report.sliceOutClaims).toBe(0);
    expect(report.crossReportConflicts).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("routes each item to the section its truth entry names, not a category guess", () => {
    const e = compile();
    const report = gradeReportTruth(m3(), e, allValidated(e), MODULE);
    const byId = new Map(report.results.map((r) => [r.truthId, r]));
    // the notification unions item names the notifications section, not the lifecycle section
    const rpt02 = byId.get("T-RPT-02")!;
    expect(rpt02.placements.map((p) => p.sectionId)).toEqual(["module-notifications-data"]);
    // the state-machine item is carried in both audiences' distinct sections
    const rpt01 = byId.get("T-RPT-01")!;
    expect(new Set(rpt01.placements.map((p) => p.sectionId))).toEqual(
      new Set(["module-objects-rules-states", "module-branches-rules-states"]),
    );
  });

  it("conserves the total across the status buckets", () => {
    const e = compile();
    const report = gradeReportTruth(m3(), e, allValidated(e), MODULE);
    const summed = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(report.total);
    expect(report.total).toBe(m3().length);
  });
});

describe("gradeReportTruth — a required authored block that did not validate fails the gate", () => {
  it("marks a must-print item missing when its section's authored block is unvalidated, and fails", () => {
    const e = compile();
    // drop one authored task in the module product notifications section from the validated set
    const notifTask = authoredTasks(e.plan).find(
      (t) => t.documentId === "module:leave|product" && t.sectionId === "module-notifications-data",
    );
    expect(notifTask, "expected an authored block in module-notifications-data").toBeDefined();
    const validated = new Set(authoredTasks(e.plan).map((t) => t.taskId));
    validated.delete(notifTask!.taskId);

    const report = gradeReportTruth(m3(), e, validated, MODULE);
    const notif = report.results.filter((r) => r.category === "notification");
    expect(notif.every((r) => r.status === "missing")).toBe(true); // section present but authored block unvalidated
    expect(report.mustPrintPrinted).toBeLessThan(report.mustPrintTotal);
    expect(report.criticalIssues).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });
});

describe("gradeReportTruth — accounting balance never substitutes for printing the fact", () => {
  it("fails when the must-print section is omitted as not-applicable, even though the omission is honest", () => {
    // make the module product notifications section not-applicable → it is omitted
    const coverage = (_t: unknown, section: SectionDefinition): readonly KindCoverageInput[] => {
      if (section.id === "module-notifications-data") {
        return section.inputFactKinds.map((kind) => ({ kind, coverage: cov({ evidencePresent: false, notApplicableConfirmed: true }) }));
      }
      return section.inputFactKinds.map((kind) => ({ kind, coverage: cov() }));
    };
    const e = compile(undefined, coverage);
    const report = gradeReportTruth(m3(), e, allValidated(e), MODULE);
    const notif = report.results.filter((r) => r.category === "notification");
    // the notifications facts expect status "found" — an omission is not acceptable, so they are missing
    expect(notif.every((r) => r.status === "missing")).toBe(true);
    expect(report.passed).toBe(false); // honest not-applicable disclosure does not satisfy a must-print
  });
});

describe("gradeReportTruth — an unroutable item cannot drop out of the denominator", () => {
  const unroutable: TruthItem = {
    id: "T-ESC",
    facets: ["M3"],
    category: "entry-point", // not in the report section lane, and no reportSections
    claim: "an M3 item that routes nowhere",
    evidence: [{ root: "wcp-service-v2", path: "x.go" }],
    expectedResolution: "observed",
    expectedStatus: "found",
    criticality: "critical",
    mustFind: true,
    mustPrint: false,
    requiredScope: ["module"],
    requiredAudience: ["product"],
  };

  it("fails a critical item that routes to no section rather than marking it unsupported", () => {
    const e = compile();
    const report = gradeReportTruth([unroutable], e, allValidated(e), MODULE);
    const result = report.results[0]!;
    expect(result.status).toBe("missing"); // not "unsupported" — it can never be printed
    expect(report.criticalIssues).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("fails a must-print item that routes nowhere", () => {
    const e = compile();
    const report = gradeReportTruth([{ ...unroutable, criticality: "normal", mustPrint: true }], e, allValidated(e), MODULE);
    expect(report.results[0]!.status).toBe("missing");
    expect(report.mustPrintTotal).toBe(1);
    expect(report.mustPrintPrinted).toBe(0);
    expect(report.passed).toBe(false);
  });
});

describe("gradeReportTruth — deterministic", () => {
  it("gives the same report for the same inputs", () => {
    const e = compile();
    const a = gradeReportTruth(m3(), e, allValidated(e), MODULE);
    const b = gradeReportTruth(m3(), e, allValidated(e), MODULE);
    expect(a).toEqual(b);
  });
});
