import { describe, expect, it } from "vitest";

import type { GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { moduleTarget, projectTarget, type ReportTarget } from "../../engine/contracts/report/target.js";
import type { SectionDefinition } from "../../engine/contracts/report/catalog.js";
import type { CoverageInput } from "../../engine/contracts/shared-fact/applicability.js";
import type { KindCoverageInput } from "../../engine/report/applicability.js";
import {
  type ExecutablePlanRequest,
  applicabilityBreakdown,
  compileExecutablePlan,
} from "../../engine/report/plan.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "src-1",
  codeGraphIdentity: "graph-1",
  providerIdentity: "providers-1",
  schemaVersion: "1.0.0",
  configIdentity: "config-1",
};
const PARAMS: GenerationParams = { executorKind: "host-agent", modelId: "claude-opus-4-8", language: "en" };

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

function base(over: Partial<ExecutablePlanRequest> = {}): ExecutablePlanRequest {
  return { request: [projectTarget("product")], snapshot: SNAPSHOT, params: PARAMS, analysisRunId: "run-1", ...over };
}

describe("compileExecutablePlan — convergence", () => {
  it("returns a plan, slices, bundles, preview, applicability and an audit digest", () => {
    const e = compileExecutablePlan(base());
    expect(e.plan.documents.length).toBe(1);
    expect(e.slices.slices.length).toBeGreaterThan(0);
    expect(e.bundlePlan.bundles.length).toBeGreaterThan(0);
    expect(e.preview.bundleCount).toBe(e.bundlePlan.bundles.length);
    expect(e.applicability.length).toBeGreaterThan(0);
    expect(e.auditDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes every section by default (all kinds found)", () => {
    const e = compileExecutablePlan(base());
    const breakdown = applicabilityBreakdown(e);
    expect(breakdown.notApplicable).toHaveLength(0);
    expect(breakdown.unknown).toHaveLength(0);
    expect(breakdown.included.length).toBe(e.applicability.length);
  });

  it("is deterministic — same inputs give the same executable plan and audit digest", () => {
    expect(compileExecutablePlan(base())).toEqual(compileExecutablePlan(base()));
  });
});

describe("compileExecutablePlan — applicability is threaded and never conflated", () => {
  // one section confirmed not-applicable (omitted), one section unknown (kept)
  const coverage = (_t: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] => {
    if (section.id === "project-notifications-data") {
      return section.inputFactKinds.map((kind) => ({ kind, coverage: cov({ evidencePresent: false, notApplicableConfirmed: true }) }));
    }
    if (section.id === "coverage") {
      return section.inputFactKinds.map((kind) => ({ kind, coverage: cov({ truncated: true }) }));
    }
    return section.inputFactKinds.map((kind) => ({ kind, coverage: cov() }));
  };

  it("omits a not-applicable section from the plan but keeps an unknown one", () => {
    const e = compileExecutablePlan(base({ coverage }));
    const sectionIds = e.plan.documents[0]!.sections.map((s) => s.sectionId);
    expect(sectionIds).not.toContain("project-notifications-data"); // not-applicable → omitted
    expect(sectionIds).toContain("coverage"); // unknown → kept and disclosed
  });

  it("records not-applicable and unknown distinctly — the two are not conflated", () => {
    const e = compileExecutablePlan(base({ coverage }));
    const breakdown = applicabilityBreakdown(e);
    expect(breakdown.notApplicable.map((a) => a.decision.sectionId)).toContain("project-notifications-data");
    expect(breakdown.unknown.map((a) => a.decision.sectionId)).toContain("coverage");
    // each carries a serializable reason
    for (const a of e.applicability) expect(a.decision.reason.length).toBeGreaterThan(0);
  });

  it("moves the audit digest when applicability changes, stable otherwise", () => {
    const included = compileExecutablePlan(base());
    const narrowed = compileExecutablePlan(base({ coverage }));
    expect(narrowed.auditDigest).not.toBe(included.auditDigest);
  });
});

describe("compileExecutablePlan — multi-document and module-only", () => {
  it("compiles one plan for all requested targets", () => {
    const e = compileExecutablePlan(base({ request: [projectTarget("product"), projectTarget("developer")] }));
    expect(e.plan.documents.map((d) => d.documentId).sort()).toEqual(["project|developer", "project|product"]);
    // a shared slice materialized once across the two documents
    expect(Object.values(e.slices.refCounts).some((n) => n > 1)).toBe(true);
  });

  it("produces no project document for a module-only request", () => {
    const e = compileExecutablePlan(base({ request: [moduleTarget("leave", "product"), moduleTarget("leave", "developer")] }));
    expect(e.plan.documents.every((d) => d.scope.kind === "module")).toBe(true);
    expect(e.plan.documents.some((d) => d.scope.kind === "project")).toBe(false);
  });

  it("excludes unrequested documents from the applicability record", () => {
    // module-only: only module sections are decided; no project-scope section
    // enters the applicability/omitted denominator.
    const e = compileExecutablePlan(base({ request: [moduleTarget("leave", "product")] }));
    const decided = new Set(e.applicability.map((a) => a.decision.sectionId));
    expect(decided.has("project-boundary")).toBe(false);
    expect([...decided].every((id) => !id.startsWith("project-"))).toBe(true);
  });
});

describe("compileExecutablePlan — dependency waves are threaded to the compiler", () => {
  it("raises the dependency-wave count when sections declare prerequisites", () => {
    const single = compileExecutablePlan(base());
    expect(single.preview.dependencyWaves).toBe(1); // V1 default: independent

    // make coverage depend on identity → a second wave
    const withDeps = compileExecutablePlan(base({ dependencies: { coverage: ["identity"] } }));
    expect(withDeps.preview.dependencyWaves).toBeGreaterThan(1);
  });

  it("fails closed on a cyclic dependency through this entry", () => {
    expect(() =>
      compileExecutablePlan(base({ dependencies: { identity: ["coverage"], coverage: ["identity"] } })),
    ).toThrow();
  });
});
