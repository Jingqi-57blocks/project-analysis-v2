import { describe, expect, it } from "vitest";

import type { CoverageInput } from "../../engine/contracts/shared-fact/applicability.js";
import {
  type SectionApplicabilityInput,
  aggregateCoverageState,
  determineSectionApplicability,
  determineSectionApplicabilities,
} from "../../engine/report/applicability.js";

/** A completed, capable, well-scoped run that found nothing — the neutral base. */
function cov(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    capable: true,
    providerRan: true,
    scopeDefined: true,
    evidencePresent: false,
    notApplicableConfirmed: false,
    failed: false,
    truncated: false,
    conflict: false,
    ...over,
  };
}

function section(
  sectionId: string,
  requirement: "required" | "optional",
  kinds: readonly { kind: string; coverage: CoverageInput }[],
): SectionApplicabilityInput {
  return { sectionId, requirement, kinds };
}

describe("determineSectionApplicability — representative sections", () => {
  it("includes a scheduler section when a scheduled job is found", () => {
    const decision = determineSectionApplicability(
      section("scheduler", "optional", [{ kind: "scheduled-job", coverage: cov({ evidencePresent: true }) }]),
    );
    expect(decision.applicability).toBe("included");
    expect(decision.state).toBe("found");
  });

  it("includes a data-model section when entities are found", () => {
    const decision = determineSectionApplicability(
      section("data-model", "required", [
        { kind: "entity", coverage: cov({ evidencePresent: true }) },
        { kind: "entity-relation", coverage: cov({ evidencePresent: true }) },
      ]),
    );
    expect(decision.applicability).toBe("included");
  });

  it("omits a UI section on a pure backend only when inapplicability is confirmed", () => {
    const decision = determineSectionApplicability(
      section("ui", "optional", [
        { kind: "ui-view", coverage: cov({ notApplicableConfirmed: true }) },
        { kind: "ui-route", coverage: cov({ notApplicableConfirmed: true }) },
      ]),
    );
    expect(decision.applicability).toBe("not-applicable");
    expect(decision.state).toBe("not-applicable");
  });

  it("marks an external-integration section unknown when the attempt was truncated", () => {
    const decision = determineSectionApplicability(
      section("integration", "required", [{ kind: "outbound-call", coverage: cov({ truncated: true }) }]),
    );
    expect(decision.applicability).toBe("unknown");
    expect(decision.state).toBe("truncated");
  });

  it("includes a required tests section that ran and found none, citing the contract", () => {
    const decision = determineSectionApplicability(
      section("tests", "required", [{ kind: "test-relation", coverage: cov() }]),
    );
    expect(decision.applicability).toBe("included");
    expect(decision.state).toBe("not-found");
    expect(decision.reason).toContain("required by the product contract");
  });
});

describe("determineSectionApplicability — the illegal collapses are unreachable", () => {
  it("never returns not-applicable for an unsupported framework, even if confirmation is asserted", () => {
    // Adversarial: capability is absent (unsupported) AND not-applicable is
    // (wrongly) asserted. Unsupported must win — a missing capability is a gap,
    // never a confirmed inapplicability.
    const decision = determineSectionApplicability(
      section("ui", "optional", [
        { kind: "ui-view", coverage: cov({ capable: false, notApplicableConfirmed: true }) },
      ]),
    );
    expect(decision.applicability).toBe("unknown");
    expect(decision.state).toBe("unsupported");
    expect(decision.evidence[0]?.gap).toBe("capability");
  });

  it("stays unknown when one dimension broke, even if another found evidence is absent", () => {
    const decision = determineSectionApplicability(
      section("integration", "required", [
        { kind: "outbound-call", coverage: cov({ failed: true }) },
        { kind: "notification-call", coverage: cov() },
      ]),
    );
    expect(decision.state).toBe("failed");
    expect(decision.applicability).toBe("unknown");
  });
});

describe("aggregateCoverageState — precedence", () => {
  it("prefers found over any gap", () => {
    expect(aggregateCoverageState(["unknown", "found", "not-applicable"])).toBe("found");
  });

  it("surfaces a blocking state over not-applicable", () => {
    expect(aggregateCoverageState(["not-applicable", "unsupported"])).toBe("unsupported");
    expect(aggregateCoverageState(["not-applicable", "failed"])).toBe("failed");
  });

  it("is not-applicable only when every kind is", () => {
    expect(aggregateCoverageState(["not-applicable", "not-applicable"])).toBe("not-applicable");
    // a mix with a defined empty is a partly-empty section — included, not omitted
    expect(aggregateCoverageState(["not-applicable", "not-found"])).toBe("not-found");
  });

  it("fails closed to unknown on empty input", () => {
    expect(aggregateCoverageState([])).toBe("unknown");
  });
});

describe("determineSectionApplicability — accounting is complete and serializable", () => {
  it("gives every decision a non-empty reason and per-kind evidence", () => {
    const decision = determineSectionApplicability(
      section("mixed", "required", [
        { kind: "condition", coverage: cov({ evidencePresent: true }) },
        { kind: "state-transition", coverage: cov({ capable: false }) },
      ]),
    );
    expect(decision.applicability).toBe("included"); // found wins
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.evidence).toHaveLength(2);
    for (const e of decision.evidence) {
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.bucket.length).toBeGreaterThan(0);
    }
    // fully serializable — no functions, no cycles
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  it("carries the capability gap and denominator bucket per kind", () => {
    const decision = determineSectionApplicability(
      section("integration", "required", [{ kind: "outbound-call", coverage: cov({ capable: false }) }]),
    );
    expect(decision.evidence[0]?.gap).toBe("capability");
    expect(decision.evidence[0]?.bucket).toBe("capability-gap");
  });

  it("fails closed to unknown when a section declares no evidence kinds", () => {
    const decision = determineSectionApplicability(section("empty", "optional", []));
    expect(decision.applicability).toBe("unknown");
    expect(decision.evidence).toHaveLength(0);
    expect(decision.reason).toContain("no evidence kinds");
  });

  it("leaves no section in an implicit default — every input yields one of the three states", () => {
    const decisions = determineSectionApplicabilities([
      section("a", "required", [{ kind: "route", coverage: cov({ evidencePresent: true }) }]),
      section("b", "optional", [{ kind: "ui-view", coverage: cov({ notApplicableConfirmed: true }) }]),
      section("c", "required", [{ kind: "entity", coverage: cov({ conflict: true }) }]),
      section("d", "optional", []),
    ]);
    expect(decisions).toHaveLength(4);
    for (const d of decisions) {
      expect(["included", "not-applicable", "unknown"]).toContain(d.applicability);
    }
    // c has conflicting inputs → unknown, not a silent empty
    expect(decisions[2]?.applicability).toBe("unknown");
  });
});
