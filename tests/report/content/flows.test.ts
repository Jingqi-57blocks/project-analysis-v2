import { describe, expect, it } from "vitest";

import { lineRef, type SourceRef } from "../../../engine/contracts/shared-fact/provenance.js";
import { SECTION_CATALOG } from "../../../engine/contracts/report/catalog.js";
import {
  MODULE_FLOWS_BLOCK,
  MODULE_RECOVERY_BLOCK,
  PM_FLOWS_AUTHORED_BLOCKS,
  type ConditionRecord,
  type DecisionRecord,
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

  it("folds decision facts as conditional branches and groups branches by flow", () => {
    const decisions: DecisionRecord[] = [
      { id: "d1", subject: "leave.route", outcomes: ["auto-approve", "manager-review"], enclosing: "Route", citation: cite("svc/leave.go", 60) },
    ];
    const set = renderBranches(conditions, decisions);
    expect(set.total).toBe(5);
    expect(set.counts.conditional).toBe(2); // c3 + d1
    expect(set.branches.find((b) => b.id === "d1")!.test).toBe("auto-approve | manager-review");
    // branches are organised into flows by their enclosing scope, not a flat list
    expect(set.flows.map((f) => f.enclosing)).toEqual(["Route", "Submit"]);
    expect(set.flows.find((f) => f.enclosing === "Submit")!.branches.length).toBe(4);
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
    expect(set.danglingTransitions).toBe(0);
  });

  it("does not count a transition for an unknown entity as rendered", () => {
    const orphan: TransitionRecord = { entityId: "ghost", from: "A", to: "B", trigger: "Go", citation: cite("x.go", 1) };
    const set = renderLifecycle(entities, states, [...transitions, orphan]);
    // the orphan is not placed in any lifecycle, so it is dangling, not rendered
    expect(set.transitionCount).toBe(3);
    expect(set.danglingTransitions).toBe(1);
    // accounting: printed excludes the dropped transition, so a slice of 4 is incomplete
    const branches = renderBranches(conditions);
    const acc = accountBehaviour(4 + set.transitionCount, branches, set, renderRules([]), renderExceptions([]));
    // slice claims all 4 transitions but only 3 rendered → incomplete, and the drop is unresolved
    expect(accountBehaviour(branches.total + 4, branches, set, renderRules([]), renderExceptions([])).complete).toBe(false);
    expect(acc.unresolved).toBeGreaterThanOrEqual(set.danglingTransitions);
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

  it("matches recovery triggers as whole words, not substrings", () => {
    // "undocumented" must NOT match "undo"; "cancellationPolicy" must NOT match "cancel"
    const decoys: TransitionRecord[] = [
      { entityId: "leave", from: "A", to: "B", trigger: "markUndocumented", citation: cite("x.go", 1) },
      { entityId: "leave", from: "A", to: "B", trigger: "cancellationPolicyCheck", citation: cite("x.go", 2) },
    ];
    expect(renderRecovery(decoys).found).toBe(false);
    // but "cancelLeave" (whole token) does match
    expect(renderRecovery([{ entityId: "leave", from: "A", to: "B", trigger: "cancelLeave", citation: cite("x.go", 3) }]).found).toBe(true);
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

  it("checks a scoped rule against its own object's lifecycle, not the union", () => {
    const twoEntities: EntityRecord[] = [...entities, { entityId: "payroll", name: "Payroll", citation: cite("svc/pay.go", 1) }];
    const payrollStates: StateRecord[] = [{ entityId: "payroll", state: "Paid", citation: cite("const/pay.go", 1) }];
    const lc = renderLifecycle(twoEntities, [...states, ...payrollStates], transitions);
    // a rule about leave that cites "Paid" (a payroll state) must be flagged, though the union has it
    const scoped = renderRules([{ id: "r1", statement: "s", subject: "x", entityId: "leave", stateName: "Paid", message: null, citation: cite("a.go", 1) }]);
    expect(validateConsistency(scoped, lc).ok).toBe(false);
    // the same state is fine for a rule scoped to payroll
    const okScoped = renderRules([{ id: "r2", statement: "s", subject: "x", entityId: "payroll", stateName: "Paid", message: null, citation: cite("a.go", 2) }]);
    expect(validateConsistency(okScoped, lc)).toEqual({ ok: true });
  });
});

describe("renderLifecycle — duplicate entity id", () => {
  it("de-dups a duplicated entity rather than double-rendering", () => {
    const dup: EntityRecord = { entityId: "leave", name: "Leave copy", citation: cite("svc/leave.go", 2) };
    const set = renderLifecycle([...entities, dup], states, transitions);
    expect(set.entityCount).toBe(1);
    expect(set.lifecycles.length).toBe(1);
    expect(set.danglingTransitions).toBeGreaterThanOrEqual(0);
  });
});

describe("authored blocks agree with the section catalog", () => {
  it("every authored block id and schema matches a catalog block", () => {
    const catalogBlocks = new Map(SECTION_CATALOG.flatMap((s) => s.blocks).map((b) => [b.id, b.outputSchemaId]));
    for (const block of PM_FLOWS_AUTHORED_BLOCKS) {
      expect(catalogBlocks.has(block.blockId)).toBe(true);
      expect(catalogBlocks.get(block.blockId)).toBe(block.outputSchemaId);
    }
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
