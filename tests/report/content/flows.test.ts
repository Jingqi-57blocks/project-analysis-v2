import { describe, expect, it } from "vitest";

import { lineRef, type SourceRef } from "../../../engine/contracts/shared-fact/provenance.js";
import {
  MODULE_FLOWS_BLOCK,
  MODULE_RECOVERY_BLOCK,
  PM_FLOWS_AUTHORED_BLOCKS,
  type ConditionRecord,
  type EntityRecord,
  type ExceptionRecord,
  type RuleRecord,
  type StateRecord,
  type TransitionRecord,
  accountBehaviour,
  renderBranches,
  renderExceptions,
  renderLifecycle,
  renderRecovery,
  renderRules,
  validateBranchSet,
  validateConsistency,
} from "../../../engine/report/content/flows.js";

const ROOT = "wcp-service-v2";
const cite = (path: string, line = 1): SourceRef => lineRef(ROOT, path, line);

const conditions: ConditionRecord[] = [
  { id: "c1", subject: "leave.days", test: "days <= balance", guard: "proceed", enclosing: "Submit", citation: cite("svc/leave.go", 10) },
  { id: "c2", subject: "leave.days", test: "days > balance", guard: "rejects", enclosing: "Submit", citation: cite("svc/leave.go", 12) },
  { id: "c3", subject: "leave.type", test: "type == sick", guard: "branches", enclosing: "Submit", citation: cite("svc/leave.go", 15) },
  { id: "c4", subject: "leave.x", test: "?", guard: "unknown", enclosing: "Submit", citation: cite("svc/leave.go", 18) },
];

describe("renderBranches — not only the happy path", () => {
  it("classifies proceed/reject/conditional/unknown and counts them", () => {
    const set = renderBranches(conditions);
    expect(set.total).toBe(4);
    expect(set.counts).toEqual({ proceed: 1, reject: 1, conditional: 1, unknown: 1 });
    // the report is not happy-path-only: rejection and conditional branches are present
    expect(set.counts.reject + set.counts.conditional).toBeGreaterThan(0);
    expect(set.branches.map((b) => b.id)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(validateBranchSet(set)).toEqual({ ok: true });
  });
});

const entities: EntityRecord[] = [{ entityId: "leave", name: "Leave", citation: cite("svc/leave.go", 1) }];
const states: StateRecord[] = [
  { entityId: "leave", state: "Draft", citation: cite("const/leave.go", 1) },
  { entityId: "leave", state: "Submitted", citation: cite("const/leave.go", 2) },
  { entityId: "leave", state: "Approved", citation: cite("const/leave.go", 3) },
];
const transitions: TransitionRecord[] = [
  { entityId: "leave", from: "Draft", to: "Submitted", trigger: "Submit", citation: cite("svc/leave.go", 20) },
  { entityId: "leave", from: "Submitted", to: "Approved", trigger: "Approve", citation: cite("svc/leave.go", 25) },
  { entityId: "leave", from: null, to: "Cancelled", trigger: "Withdraw", citation: cite("svc/leave.go", 30) }, // unresolved origin
];

describe("renderLifecycle", () => {
  it("connects states and transitions, marks terminals and unresolved origins", () => {
    const set = renderLifecycle(entities, states, transitions);
    const leave = set.lifecycles[0]!;
    // states include one seen only in a transition (Cancelled)
    expect(leave.states).toEqual(["Approved", "Cancelled", "Draft", "Submitted"]);
    expect(leave.transitions.length).toBe(3);
    // Approved and Cancelled have no outgoing transition → terminal
    expect(leave.terminalStates).toContain("Approved");
    expect(leave.terminalStates).toContain("Cancelled");
    // the from:null transition is surfaced, not invented into a state
    expect(leave.unresolvedOrigins).toBe(1);
    expect(set.transitionCount).toBe(3);
  });
});

describe("renderRules", () => {
  it("keeps rules in order with their state names and citations", () => {
    const rules: RuleRecord[] = [
      { id: "r1", statement: "an approved leave cannot be edited", subject: "leave.status", stateName: "Approved", message: null, citation: cite("svc/leave.go", 40) },
    ];
    const set = renderRules(rules);
    expect(set.ruleCount).toBe(1);
    expect(set.rules[0]!.stateName).toBe("Approved");
  });
});

describe("renderExceptions", () => {
  it("counts exceptions by kind", () => {
    const exceptions: ExceptionRecord[] = [
      { id: "x1", kind: "validation", subject: "days", message: "days must be positive", citation: cite("svc/leave.go", 50) },
      { id: "x2", kind: "discarded-error", subject: "notify", message: null, citation: cite("svc/leave.go", 55) },
    ];
    const set = renderExceptions(exceptions);
    expect(set.total).toBe(2);
    expect(set.counts.validation).toBe(1);
    expect(set.counts["discarded-error"]).toBe(1);
  });
});

describe("renderRecovery — evidenced or honestly unknown", () => {
  it("finds recovery transitions by their trigger", () => {
    const set = renderRecovery(transitions); // has a "Withdraw" trigger
    expect(set.found).toBe(true);
    expect(set.recoveries.map((r) => r.trigger)).toContain("Withdraw");
  });

  it("reports unknown when no recovery is evidenced", () => {
    const noRecovery = transitions.filter((t) => t.trigger !== "Withdraw");
    const set = renderRecovery(noRecovery);
    expect(set.found).toBe(false);
    expect(set.recoveries).toHaveLength(0);
  });
});

describe("accountBehaviour — every fact printed or accounted", () => {
  it("is complete only when printed equals the slice size", () => {
    const branches = renderBranches(conditions);
    const lifecycle = renderLifecycle(entities, states, transitions);
    const rules = renderRules([{ id: "r1", statement: "s", subject: "x", stateName: "Approved", message: null, citation: cite("a.go", 1) }]);
    const exceptions = renderExceptions([{ id: "x1", kind: "validation", subject: "y", message: null, citation: cite("a.go", 2) }]);
    // slice = 4 branches + 3 transitions + 1 rule + 1 exception = 9
    const acc = accountBehaviour(9, branches, lifecycle, rules, exceptions);
    expect(acc.printed).toBe(9);
    expect(acc.complete).toBe(true);
    expect(acc.unresolved).toBeGreaterThan(0); // the from:null transition + the unknown branch
    // a dropped fact (slice claims 10) → incomplete
    expect(accountBehaviour(10, branches, lifecycle, rules, exceptions).complete).toBe(false);
  });
});

describe("validateConsistency — rules, states and exceptions do not contradict", () => {
  const lifecycle = renderLifecycle(entities, states, transitions);

  it("passes when a rule names a state the lifecycle has", () => {
    const rules = renderRules([{ id: "r1", statement: "s", subject: "x", stateName: "Approved", message: null, citation: cite("a.go", 1) }]);
    expect(validateConsistency(rules, lifecycle)).toEqual({ ok: true });
  });

  it("flags a rule that names a state no lifecycle has", () => {
    const rules = renderRules([{ id: "r1", statement: "s", subject: "x", stateName: "Archived", message: null, citation: cite("a.go", 1) }]);
    const result = validateConsistency(rules, lifecycle);
    expect(result.ok).toBe(false);
  });
});

describe("authored-block contracts", () => {
  it("require citations, name their schema/validator and carry a prompt that shows non-happy paths", () => {
    for (const block of PM_FLOWS_AUTHORED_BLOCKS) {
      expect(block.citationRule).toBe("required");
      expect(block.validatorId).toBe(block.outputSchemaId);
      expect(block.inputFactKinds.length).toBeGreaterThan(0);
      expect(block.prompt.length).toBeGreaterThan(0);
    }
    expect(MODULE_FLOWS_BLOCK.prompt.toLowerCase()).toContain("rejection");
    expect(MODULE_RECOVERY_BLOCK.prompt.toLowerCase()).toContain("unknown");
  });
});
