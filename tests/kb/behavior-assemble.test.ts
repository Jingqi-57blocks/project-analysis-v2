import { describe, expect, it } from "vitest";

import { declared, inferred, resolved, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";
import type { ConditionRecord } from "../../engine/structural/rules.js";
import type { AuthAnnotationRecord, DataAccessRecord, TestRelationRecord } from "../../engine/structural/boundaries.js";
import type { BusinessRule } from "../../engine/semantics/rules.js";
import type { ValueSet } from "../../engine/semantics/enums.js";
import { validateBehaviorModel } from "../../engine/contracts/behavior/schema.js";
import { gradeBehaviorTruth } from "../support/gates/behavior-truth.js";
import type { TruthItem } from "../../engine/contracts/truth/schema.js";
import { type AssembleInput, assembleBehaviorModel } from "../../engine/kb/behavior-assemble.js";

const ROOT = "wcp-service-v2";
const sym = symbolId({ rootName: ROOT, relPath: "svc/handler.go", kind: "function", qualifiedName: "Approve", signature: null });

const statusSet: ValueSet = {
  name: "LeaveStatus",
  rootName: ROOT,
  relPath: "internal/constant/leave.go",
  startLine: 96,
  members: [
    { name: "Draft", value: 1 },
    { name: "Submitted", value: 2 },
    { name: "Approved", value: 4 },
  ],
};

function condition(subject: string, literal: number): ConditionRecord {
  return {
    rootName: ROOT,
    subject,
    operator: "==",
    literal,
    literalKind: "numeric",
    text: `${subject} == ${literal}`,
    enclosingFunction: "Approve",
    guarded: "rejects",
    source: lineRef(ROOT, "svc/handler.go", 20),
    provenance: declared(lineRef(ROOT, "svc/handler.go", 20)),
  };
}

const rule: BusinessRule = {
  rootName: ROOT,
  subject: "leave.Status",
  operator: "==",
  literal: 4,
  statement: "leave is approved",
  meanings: ["approved"],
  valueSetName: "LeaveStatus",
  relPath: "svc/handler.go",
  startLine: 22,
  text: "leave.Status == 4",
  fullTest: null,
  guarded: "rejects",
  enclosingFunction: "Approve",
};

const auth: AuthAnnotationRecord = {
  rootName: ROOT,
  symbolId: sym,
  mechanism: "requireRole",
  requirement: "manager",
  source: lineRef(ROOT, "svc/mw.go", 5),
  provenance: inferred(lineRef(ROOT, "svc/mw.go", 5), "low"),
};

const dataAccess: DataAccessRecord = {
  rootName: ROOT,
  entity: "leaves",
  operation: "write",
  mechanism: "gorm",
  symbolId: sym,
  provenance: declared(lineRef(ROOT, "svc/repo.go", 30)),
};

const testRel: TestRelationRecord = {
  rootName: ROOT,
  testSymbolId: symbolId({ rootName: ROOT, relPath: "svc/handler_test.go", kind: "function", qualifiedName: "TestApprove", signature: null }),
  targetSymbolId: sym,
  targetName: "Approve",
  relation: "covers",
  provenance: resolved(lineRef(ROOT, "svc/handler_test.go", 8), "high"),
};

function input(): AssembleInput {
  return {
    decisions: { conditions: [condition("leave.Status", 4)], decisions: [], guards: [], rules: [rule], valueSets: [statusSet] },
    states: {
      valueSets: [statusSet],
      conditions: [condition("leave.Status", 4)],
      changes: [{ rootName: ROOT, field: "leave.Status", fromValue: 1, toValue: 2, trigger: "Submit", guard: null, source: lineRef(ROOT, "svc/handler.go", 40) }],
    },
    boundary: { auth: [auth], validations: [], errorHandling: [], discarded: [] },
    sideEffects: { dataAccess: [dataAccess], transactions: [], outbound: [], external: [], notifications: [] },
    tests: { testRelations: [testRel], providerRan: true },
  };
}

describe("assembleBehaviorModel", () => {
  it("converges all five derivers into one contract-valid model", () => {
    const { model } = assembleBehaviorModel(input());
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
    const kinds = new Set(model.facts.map((f) => f.kind));
    // a fact from every lane: PI-11 semantics + PI-12 side-effect + test
    for (const k of ["business-rule", "value-set", "state", "transition", "condition", "auth-annotation", "data-access", "test-relation"]) {
      expect(kinds.has(k)).toBe(true);
    }
    // every fact id is unique across derivers (converged once)
    expect(model.facts.length).toBe(new Set(model.facts.map((f) => f.factId)).size);
  });

  it("returns the model in a stable order by identity, whatever the deriver order", () => {
    const { model } = assembleBehaviorModel(input());
    expect(model.facts.map((f) => f.factId)).toEqual([...model.facts.map((f) => f.factId)].sort());
  });

  it("propagates state diagnostics and test coverage", () => {
    const withUnresolved: AssembleInput = {
      ...input(),
      states: { ...input().states, changes: [{ rootName: ROOT, field: "leave.Status", fromValue: null, toValue: 2, trigger: "Submit", guard: null, source: lineRef(ROOT, "x.go", 1) }] },
      tests: { testRelations: [], providerRan: false },
    };
    const out = assembleBehaviorModel(withUnresolved);
    expect(out.diagnostics.some((d) => d.startsWith("state:undeterminable-start"))).toBe(true);
    expect(out.testCoverage).toBe("not-run");
  });

  it("end-to-end: the assembled model satisfies the behaviour truth gate for cited facts", () => {
    const { model } = assembleBehaviorModel(input());
    const items: TruthItem[] = [
      truthItem("T-ST", "state-set", "internal/constant/leave.go"),
      truthItem("T-RULE", "rule", "svc/handler.go"),
      truthItem("T-SE", "side-effect", "svc/repo.go"),
      truthItem("T-PERM", "permission", "svc/mw.go"),
    ];
    const report = gradeBehaviorTruth(items, model, ROOT);
    expect(report.results.every((r) => r.status === "found")).toBe(true);
    expect(report.passed).toBe(true);
  });
});

function truthItem(id: string, category: string, path: string): TruthItem {
  return {
    id,
    facets: ["M2"],
    category,
    claim: "c",
    evidence: [{ root: ROOT, path, lines: "1" }],
    expectedResolution: "observed",
    expectedStatus: "found",
    criticality: "critical",
    mustFind: true,
    mustPrint: true,
    requiredScope: ["module"],
    requiredAudience: ["developer"],
  };
}
