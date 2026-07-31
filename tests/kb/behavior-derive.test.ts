import { describe, expect, it } from "vitest";

import { declared, lineRef } from "../../engine/structural/provenance.js";
import type { ConditionRecord, DecisionRecord, GuardRecord } from "../../engine/structural/rules.js";
import type { BusinessRule } from "../../engine/semantics/rules.js";
import type { ValueSet } from "../../engine/semantics/enums.js";
import { validateBehaviorModel } from "../../engine/contracts/behavior/schema.js";
import { type BehaviorDeriveInput, deriveDecisionBehavior } from "../../engine/kb/behavior-derive.js";

function condition(subject: string, operator: string, literal: number | string, guarded: ConditionRecord["guarded"] = null): ConditionRecord {
  return {
    rootName: "svc",
    subject,
    operator,
    literal,
    literalKind: typeof literal === "number" ? "numeric" : "string",
    text: `${subject} ${operator} ${literal}`,
    enclosingFunction: "Approve",
    guarded,
    source: lineRef("svc", "a.go", 10),
    provenance: declared(lineRef("svc", "a.go", 10)),
  };
}

function guard(test: string, message: string, messageKind: GuardRecord["messageKind"]): GuardRecord {
  return {
    rootName: "svc",
    test,
    message,
    messageKind,
    enclosingFunction: "Approve",
    source: lineRef("svc", "a.go", 20),
    provenance: declared(lineRef("svc", "a.go", 20)),
  };
}

function rule(subject: string, valueSetName: string | null, meanings: readonly string[]): BusinessRule {
  return {
    rootName: "svc",
    subject,
    operator: "==",
    literal: 4,
    statement: `${subject} is approved`,
    meanings: [...meanings],
    valueSetName,
    relPath: "a.go",
    startLine: 30,
    text: `${subject} == 4`,
    fullTest: null,
    guarded: "rejects",
    enclosingFunction: "Approve",
  };
}

function valueSet(name: string): ValueSet {
  return {
    name,
    rootName: "svc",
    relPath: "consts.go",
    startLine: 1,
    members: [
      { name: "Draft", value: 1 },
      { name: "Approved", value: 4 },
    ],
  };
}

function ifDecision(subject: string): DecisionRecord {
  return {
    rootName: "svc",
    kind: "if",
    subject,
    enclosingFunction: "Approve",
    startLine: 40,
    endLine: 60,
    truncated: false,
    source: lineRef("svc", "a.go", 40),
    provenance: declared(lineRef("svc", "a.go", 40)),
    branches: [
      {
        test: `${subject} > 40`,
        values: [40],
        outcome: "leaves",
        startLine: 41,
        endLine: 43,
        decisions: [
          // a decision nested inside the first branch — must not be lost
          {
            rootName: "svc",
            kind: "if",
            subject: "flow",
            enclosingFunction: "Approve",
            startLine: 42,
            endLine: 43,
            truncated: false,
            source: lineRef("svc", "a.go", 42),
            provenance: declared(lineRef("svc", "a.go", 42)),
            branches: [{ test: "flow == L1", values: ["L1"], outcome: "continues", startLine: 42, endLine: 43, decisions: [] }],
          },
        ],
      },
      { test: "otherwise", values: [], outcome: "continues", startLine: 44, endLine: 46, decisions: [] },
    ],
  };
}

function derive(over: Partial<BehaviorDeriveInput> = {}) {
  const input: BehaviorDeriveInput = {
    conditions: over.conditions ?? [],
    decisions: over.decisions ?? [],
    guards: over.guards ?? [],
    rules: over.rules ?? [],
    valueSets: over.valueSets ?? [],
  };
  return deriveDecisionBehavior(input);
}

describe("deriveDecisionBehavior", () => {
  it("produces a model that validates against the behaviour contract", () => {
    const model = derive({
      conditions: [condition("lv.Hours", ">", 40, "rejects")],
      guards: [guard("maxAvailable < total", "not enough balance", "stated")],
      rules: [rule("lv.Status", "LvStatus", ["approved"])],
      valueSets: [valueSet("LvStatus")],
      decisions: [ifDecision("lv.Hours")],
    });
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
  });

  it("maps each source record to exactly one fact of its kind — no duplicates, none invented", () => {
    const model = derive({
      conditions: [condition("a", ">", 1), condition("b", "<", 2)],
      guards: [guard("g", "m", "stated")],
      rules: [rule("r", null, ["x"])],
      valueSets: [valueSet("VS")],
    });
    const byKind = (k: string) => model.facts.filter((f) => f.kind === k).length;
    expect(byKind("condition")).toBe(2);
    expect(byKind("guard")).toBe(1);
    expect(byKind("business-rule")).toBe(1);
    expect(byKind("value-set")).toBe(1);
    // every fact id is unique (no duplicate rows)
    expect(model.facts.length).toBe(new Set(model.facts.map((f) => f.factId)).size);
  });

  it("keeps every branch, including early-return and nested branches", () => {
    const model = derive({ decisions: [ifDecision("lv.Hours")] });
    // 2 decisions (outer + nested), each of their branches a condition fact:
    // outer has 2 branches, nested has 1 -> 3 branch conditions
    expect(model.facts.filter((f) => f.kind === "decision")).toHaveLength(2);
    expect(model.facts.filter((f) => f.kind === "condition")).toHaveLength(3);
    // an early-return branch is recorded with a leaves outcome
    const branchRoles = model.relations.filter((r) => r.kind === "decision-branch").map((r) => r.role);
    expect(branchRoles).toContain("leaves");
    expect(branchRoles).toContain("continues");
  });

  it("links a rule to the value set it reads", () => {
    const model = derive({ rules: [rule("lv.Status", "LvStatus", ["approved"])], valueSets: [valueSet("LvStatus")] });
    const link = model.relations.find((r) => r.kind === "rule-valueset");
    expect(link).toBeDefined();
    const vs = model.facts.find((f) => f.kind === "value-set")!;
    expect(link!.to).toBe(vs.factId);
  });

  it("does not link a rule whose value set was not derived", () => {
    const model = derive({ rules: [rule("lv.Status", "MissingSet", ["approved"])], valueSets: [] });
    expect(model.relations.some((r) => r.kind === "rule-valueset")).toBe(false);
  });

  it("keeps an unexplained rule at low confidence rather than dropping it", () => {
    const model = derive({ rules: [rule("mystery", null, [])] });
    const fact = model.facts.find((f) => f.kind === "business-rule")!;
    expect(fact.evidence[0]!.provenance).toMatchObject({ resolutionClass: "inferred", confidence: "low" });
  });

  it("keeps a stated guard message but not an error-code symbol as prose", () => {
    const model = derive({
      guards: [guard("a < b", "balance too low", "stated"), guard("c < d", "ErrorCodes.WKL_Forbidden", "error-code")],
    });
    const test = (f: { payload: unknown }) => (f.payload as { test?: string }).test;
    const stated = model.facts.find((f) => test(f) === "a < b")!;
    const coded = model.facts.find((f) => test(f) === "c < d")!;
    expect((stated.payload as unknown as { message: string | null }).message).toBe("balance too low");
    expect((coded.payload as unknown as { message: string | null }).message).toBeNull();
    expect((coded.payload as unknown as { errorCode: string | null }).errorCode).toBe("ErrorCodes.WKL_Forbidden");
  });

  it("returns an empty, valid model for no input", () => {
    const model = derive();
    expect(model.facts).toEqual([]);
    expect(validateBehaviorModel(model).ok).toBe(true);
  });
});
