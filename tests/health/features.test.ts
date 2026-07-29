import { describe, expect, it } from "vitest";

import { computeFeatureFindings } from "../../engine/health/features.js";
import type { ReportFeature, ReportFlow } from "../../engine/report/model.js";

function flow(overrides: Partial<ReportFlow> = {}): ReportFlow {
  return {
    entryKey: "svc:POST /v2/leaves",
    method: "POST",
    path: "/v2/leaves",
    steps: [
      {
        kind: "frontend-call",
        label: "ui",
        rootName: "ui",
        conditions: [],
        unresolvedReason: null,
        truncated: false,
        indirect: false,
        location: "ui/src/api.ts:1",
      },
      {
        kind: "route",
        label: "POST /v2/leaves",
        rootName: "svc",
        conditions: ["middleware auth.Authentication"],
        unresolvedReason: null,
        truncated: false,
        indirect: false,
        location: "svc/handlers.go:1",
      },
      {
        kind: "handler",
        label: "Creation",
        rootName: "svc",
        conditions: [],
        unresolvedReason: null,
        truncated: false,
        indirect: false,
        location: "svc/router.go:30",
      },
    ],
    diagram: "flowchart LR",
    partial: false,
    ...overrides,
  };
}

function feature(overrides: Partial<ReportFeature> = {}): ReportFeature {
  return {
    id: "feat_leave",
    name: "Leave",
    rootNames: ["svc"],
    signals: ["27 endpoints"],
    endpoints: [{ method: "POST", path: "/v2/leaves", rootName: "svc" }],
    dataEntities: [],
    tables: ["wcp_leave"],
    flows: [flow()],
    totalFlowCount: 1,
    overviewDiagram: "flowchart LR",
    partialFlowCount: 0,
    findings: [],
    ...overrides,
  };
}

/** The route step with its middleware removed. */
function withoutAuth(): ReportFlow {
  const base = flow();
  return {
    ...base,
    steps: base.steps.map((step) => (step.kind === "route" ? { ...step, conditions: [] } : step)),
  };
}

describe("computeFeatureFindings", () => {
  it("reports endpoints registered without recognisable authentication", () => {
    const findings = computeFeatureFindings([feature({ flows: [withoutAuth()] })]);
    const auth = findings.find((f) => f.id === "endpoints-without-observed-auth");

    expect(auth).toBeDefined();
    expect(auth!.evidence).toEqual(["POST /v2/leaves"]);
    expect(auth!.featureName).toBe("Leave");
  });

  it("says nothing about authentication when middleware was observed", () => {
    const findings = computeFeatureFindings([feature()]);
    expect(findings.some((f) => f.id === "endpoints-without-observed-auth")).toBe(false);
  });

  it("treats several auth spellings as authentication", () => {
    for (const middleware of ["passport.authenticate", "jwtGuard", "requireSession", "checkPermission"]) {
      const base = flow();
      const guarded = {
        ...base,
        steps: base.steps.map((step) =>
          step.kind === "route" ? { ...step, conditions: [`middleware ${middleware}`] } : step,
        ),
      };
      const findings = computeFeatureFindings([feature({ flows: [guarded] })]);
      expect(findings.some((f) => f.id === "endpoints-without-observed-auth")).toBe(false);
    }
  });

  it("raises the severity when nothing in the feature is guarded", () => {
    const all = computeFeatureFindings([feature({ flows: [withoutAuth()] })]);
    expect(all.find((f) => f.id === "endpoints-without-observed-auth")!.severity).toBe("concern");

    const some = computeFeatureFindings([
      feature({ flows: [withoutAuth(), flow()], totalFlowCount: 2 }),
    ]);
    expect(some.find((f) => f.id === "endpoints-without-observed-auth")!.severity).toBe("notice");
  });

  it("reports an endpoint nothing was seen to call", () => {
    const base = flow();
    const uncalled = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "frontend-call" ? { ...step, unresolvedReason: "no call resolves" } : step,
      ),
    };
    const findings = computeFeatureFindings([feature({ flows: [uncalled] })]);
    expect(findings.some((f) => f.id === "endpoints-without-observed-caller")).toBe(true);
  });

  it("reports a feature whose tables were only seen near the handlers", () => {
    const base = flow();
    const nearby = {
      ...base,
      steps: [
        ...base.steps,
        {
          kind: "data-access",
          label: "wcp_leave",
          rootName: "svc",
          conditions: ["write"],
          unresolvedReason: null,
          truncated: false,
          indirect: true,
          location: "svc/service.go:12",
        },
      ],
    };
    const findings = computeFeatureFindings([feature({ flows: [nearby] })]);
    expect(findings.some((f) => f.id === "storage-observed-only-nearby")).toBe(true);
  });

  it("says nothing at all about a feature with nothing to say", () => {
    expect(computeFeatureFindings([feature({ tables: ["wcp_leave"] })])).toEqual([]);
  });

  it("never asserts an absence it cannot establish", () => {
    // A check written inside a handler body is out of this tool's reach, so
    // "has no authentication" would be a claim it cannot support. Every
    // finding must be worded as what was observed.
    const findings = computeFeatureFindings([
      feature({ flows: [withoutAuth()], tables: [] }),
      feature({ id: "f2", name: "Worklog", flows: [flow()], tables: [] }),
    ]);

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      const text = `${finding.title} ${finding.finding}`.toLowerCase();
      expect(text).not.toMatch(/\bhas no\b|\bhave no\b|\blacks\b|\bmissing\b|\bis insecure\b/);
      expect(text).toMatch(/observed|found|could not|may |not established|not reached/);
    }
  });
});
