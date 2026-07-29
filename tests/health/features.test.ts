import { describe, expect, it } from "vitest";

import { computeFeatureFindings } from "../../engine/health/features.js";
import type { ReviewedFeature, ReviewedFlow } from "../../engine/health/features.js";

function flow(overrides: Partial<ReviewedFlow> = {}): ReviewedFlow {
  return {
    method: "POST",
    path: "/v2/leaves",
    steps: [
      {
        kind: "frontend-call",
        conditions: [],
        unresolvedReason: null,
        indirect: false,
      },
      {
        kind: "route",
        conditions: ["middleware auth.Authentication"],
        unresolvedReason: null,
        indirect: false,
      },
      {
        kind: "handler",
        conditions: [],
        unresolvedReason: null,
        indirect: false,
      },
    ],
    ...overrides,
  };
}

function feature(overrides: Partial<ReviewedFeature> = {}): ReviewedFeature {
  return {
    id: "feat_leave",
    name: "Leave",
    tables: ["wcp_leave"],
    flows: [flow()],
    ...overrides,
  };
}

/** The route step with its middleware removed. */
function withoutAuth(): ReviewedFlow {
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
      feature({ flows: [withoutAuth(), flow()] }),
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
          conditions: ["write"],
          unresolvedReason: null,
          indirect: true,
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
