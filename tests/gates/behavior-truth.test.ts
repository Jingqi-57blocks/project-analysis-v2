import { describe, expect, it } from "vitest";

import { loadLeaveTruthLedger, itemsForFacet } from "../../engine/contracts/truth/leave.js";
import type { TruthItem } from "../../engine/contracts/truth/schema.js";
import type { EvidenceRecord } from "../../engine/contracts/shared-fact/evidence.js";
import { factId } from "../../engine/contracts/shared-fact/identity.js";
import { declared, lineRef } from "../../engine/contracts/shared-fact/provenance.js";
import type { BehaviorFact, BehaviorModel } from "../../engine/contracts/behavior/schema.js";
import { gradeBehaviorTruth, type TruthStatus } from "../../engine/gates/behavior-truth.js";

const ROOT = "wcp-service-v2";

function fact(kind: string, relPath: string, disc = "1"): BehaviorFact {
  const evidence: EvidenceRecord = {
    attribution: { providerId: "x", providerVersion: "1.0.0" },
    provenance: declared(lineRef(ROOT, relPath, 1)),
  };
  return {
    factId: factId({ family: "behavioral", kind, discriminators: [relPath, disc] }),
    family: "behavioral",
    kind,
    schemaVersion: "1.0.0",
    evidence: [evidence],
    rawIdentities: [],
    payload: { scope: "module", activation: "always" },
  };
}

function model(facts: BehaviorFact[] = []): BehaviorModel {
  return { schemaVersion: "1.0.0", facts, relations: [] };
}

function item(over: Partial<TruthItem>): TruthItem {
  return {
    id: "T-X",
    facets: ["M2"],
    category: "state-set",
    claim: "c",
    evidence: [{ root: ROOT, path: "internal/constant/leave.go", lines: "1-2" }],
    expectedResolution: "observed",
    expectedStatus: "found",
    criticality: "normal",
    mustFind: true,
    mustPrint: true,
    requiredScope: ["module"],
    requiredAudience: ["developer"],
    ...over,
  };
}

const sum = (counts: Record<TruthStatus, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

describe("gradeBehaviorTruth — the real M2 ledger", () => {
  const m2 = itemsForFacet(loadLeaveTruthLedger(), "M2");

  it("puts every M2 item in exactly one mutually-exclusive bucket, total conserved", () => {
    const report = gradeBehaviorTruth(m2, model(), ROOT);
    expect(report.total).toBe(m2.length);
    expect(sum(report.counts)).toBe(m2.length); // no item counted twice or dropped
  });

  it("marks role and object items unsupported (owned by other lanes), not failed", () => {
    const report = gradeBehaviorTruth(m2, model(), ROOT);
    const other = report.results.filter((r) => r.category === "role" || r.category === "object");
    expect(other.length).toBeGreaterThan(0);
    expect(other.every((r) => r.status === "unsupported")).toBe(true);
  });

  it("does not pass on an empty model — the behaviour must-finds are not-found", () => {
    const report = gradeBehaviorTruth(m2, model(), ROOT);
    expect(report.passed).toBe(false);
    expect(report.mustFindFound).toBeLessThan(report.mustFindTotal);
  });
});

describe("gradeBehaviorTruth — grading logic", () => {
  it("finds a behaviour fact of the category's kind at the cited path", () => {
    const report = gradeBehaviorTruth([item({ category: "state-set" })], model([fact("state", "internal/constant/leave.go")]), ROOT);
    expect(report.results[0]!.status).toBe("found");
    expect(report.results[0]!.lane).toBe("behavior-semantics");
  });

  it("marks a cited behaviour with no matching fact not-found", () => {
    const report = gradeBehaviorTruth([item({ category: "transition" })], model([fact("state", "internal/constant/leave.go")]), ROOT);
    expect(report.results[0]!.status).toBe("not-found");
  });

  it("classifies a side-effect category on the PI-12 lane and finds its fact", () => {
    const it2 = item({ category: "notification", evidence: [{ root: ROOT, path: "internal/service/notify.go", lines: "1" }] });
    const report = gradeBehaviorTruth([it2], model([fact("notification-call", "internal/service/notify.go")]), ROOT);
    expect(report.results[0]!.lane).toBe("side-effect");
    expect(report.results[0]!.status).toBe("found");
  });

  it("honours an absence item when nothing is there, and flags it when something is", () => {
    const abs = item({ category: "side-effect", expectedStatus: "absent", mustFind: false, evidence: [{ root: ROOT, path: "internal/x.go", lines: "1" }] });
    expect(gradeBehaviorTruth([abs], model(), ROOT).results[0]!.status).toBe("found");
    expect(gradeBehaviorTruth([abs], model([fact("data-access", "internal/x.go")]), ROOT).results[0]!.status).toBe("not-found");
  });

  it("marks an item with no evidence in the indexed root unresolved", () => {
    const other = item({ evidence: [{ root: "wcp-ui", path: "src/x.ts", lines: "1" }] });
    expect(gradeBehaviorTruth([other], model(), ROOT).results[0]!.status).toBe("unresolved");
  });

  it("passes only when every must-find is found and no critical is unfound", () => {
    const items = [
      item({ id: "A", category: "state-set", criticality: "critical" }),
      item({ id: "B", category: "transition", evidence: [{ root: ROOT, path: "internal/svc/route.go", lines: "1" }] }),
    ];
    const facts = [fact("state", "internal/constant/leave.go"), fact("transition", "internal/svc/route.go")];
    const report = gradeBehaviorTruth(items, model(facts), ROOT);
    expect(report.passed).toBe(true);
    expect(report.denominator).toBe(2);

    // drop the transition fact -> B not-found -> gate fails
    const failing = gradeBehaviorTruth(items, model([facts[0]!]), ROOT);
    expect(failing.passed).toBe(false);
  });
});
