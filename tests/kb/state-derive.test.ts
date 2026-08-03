import { describe, expect, it } from "vitest";

import { declared, lineRef } from "../../engine/structural/provenance.js";
import type { ConditionRecord } from "../../engine/structural/rules.js";
import type { ValueSet } from "../../engine/semantics/enums.js";
import { validateBehaviorModel } from "../../engine/contracts/behavior/schema.js";
import {
  type StateChangeObservation,
  deriveStateBehavior,
} from "../../engine/kb/state-derive.js";

function valueSet(name: string, root = "svc"): ValueSet {
  return {
    name,
    rootName: root,
    relPath: "consts.go",
    startLine: 1,
    members: [
      { name: "Draft", value: 1 },
      { name: "Submitted", value: 2 },
      { name: "Approved", value: 4 },
    ],
  };
}

function condition(subject: string, literal: number | string, root = "svc"): ConditionRecord {
  return {
    rootName: root,
    subject,
    operator: "==",
    literal,
    literalKind: typeof literal === "number" ? "numeric" : "string",
    text: `${subject} == ${literal}`,
    enclosingFunction: "Approve",
    guarded: "rejects",
    source: lineRef(root, "a.go", 10),
    provenance: declared(lineRef(root, "a.go", 10)),
  };
}

function change(over: Partial<StateChangeObservation> = {}): StateChangeObservation {
  return {
    rootName: "svc",
    field: "leave.Status",
    fromValue: 1,
    toValue: 2,
    trigger: "SubmitLeave",
    guard: "isOwner",
    source: lineRef("svc", "a.go", 22),
    ...over,
  };
}

const set = () => valueSet("LeaveStatus");

describe("deriveStateBehavior — states", () => {
  it("makes a state from a value a condition compares against, with definition evidence", () => {
    const { model } = deriveStateBehavior({ valueSets: [set()], conditions: [condition("leave.Status", 4)] });
    const states = model.facts.filter((f) => f.kind === "state");
    expect(states).toHaveLength(1);
    expect((states[0]!.payload as unknown as { label: string }).label).toBe("Approved");
    expect(states[0]!.evidence[0]!.provenance.source.relPath).toBe("consts.go");
  });

  it("does not turn a value set nothing compares into a state machine", () => {
    const { model } = deriveStateBehavior({ valueSets: [valueSet("Colours")], conditions: [] });
    expect(model.facts.filter((f) => f.kind === "state")).toHaveLength(0);
  });

  it("resolves same-named sets to the one in the condition's own root", () => {
    const here = valueSet("LeaveStatus", "svc");
    const stranger = valueSet("LeaveStatus", "other");
    const { model } = deriveStateBehavior({ valueSets: [stranger, here], conditions: [condition("leave.Status", 4, "svc")] });
    const state = model.facts.find((f) => f.kind === "state")!;
    expect(state.evidence[0]!.provenance.source.rootName).toBe("svc");
  });

  it("handles a string-valued status as its own state", () => {
    const stringy: ValueSet = { name: "LeaveStatus", rootName: "svc", relPath: "c.ts", startLine: 1, members: [{ name: "Open", value: "open" }] };
    const { model } = deriveStateBehavior({ valueSets: [stringy], conditions: [condition("leave.Status", "open")] });
    expect(model.facts.filter((f) => f.kind === "state")).toHaveLength(1);
  });
});

describe("deriveStateBehavior — transitions", () => {
  it("builds a transition with from/to endpoints when both resolve, and validates", () => {
    const { model, diagnostics } = deriveStateBehavior({
      valueSets: [set()],
      conditions: [],
      changes: [change({ fromValue: 1, toValue: 2 })],
    });
    expect(diagnostics).toEqual([]);
    const transition = model.facts.find((f) => f.kind === "transition")!;
    expect(transition).toBeDefined();
    const endpoints = model.relations.filter((r) => r.kind === "transition-endpoint" && r.from === transition.factId);
    expect(endpoints.map((r) => r.role).sort()).toEqual(["from-state", "to-state"]);
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
  });

  it("carries the trigger and guard on the transition", () => {
    const { model } = deriveStateBehavior({ valueSets: [set()], conditions: [], changes: [change()] });
    const t = model.facts.find((f) => f.kind === "transition")!;
    expect((t.payload as unknown as { trigger: string }).trigger).toBe("SubmitLeave");
    expect((t.payload as unknown as { guard: string | null }).guard).toBe("isOwner");
    expect((t.payload as unknown as { activation: string }).activation).toBe("guarded");
  });

  it("emits a to-only transition when the start is undeterminable, keeping the note", () => {
    const { model, diagnostics } = deriveStateBehavior({ valueSets: [set()], conditions: [], changes: [change({ fromValue: null, toValue: 2 })] });
    const transition = model.facts.find((f) => f.kind === "transition")!;
    expect(transition).toBeDefined();
    const endpoints = model.relations.filter((r) => r.kind === "transition-endpoint" && r.from === transition.factId);
    expect(endpoints.map((r) => r.role)).toEqual(["to-state"]);
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
    // the missing origin is still recorded, so a reader can see the start was not stated
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.kind).toBe("undeterminable-start");
  });

  it("records an unresolved target explicitly", () => {
    const { model, diagnostics } = deriveStateBehavior({ valueSets: [set()], conditions: [], changes: [change({ fromValue: 1, toValue: 999 })] });
    expect(model.facts.some((f) => f.kind === "transition")).toBe(false);
    expect(diagnostics[0]!.kind).toBe("unresolved-target");
  });

  it("never resolves an exact set name through a numerically equal member of another enum", () => {
    const leave: ValueSet = {
      name: "LeaveRequestStatus",
      rootName: "svc",
      relPath: "leave.ts",
      startLine: 1,
      members: [{ name: "Pending", value: 1 }, { name: "Approved", value: 4 }],
    };
    const billing: ValueSet = {
      name: "BillingStatus",
      rootName: "svc",
      relPath: "billing.ts",
      startLine: 1,
      members: [{ name: "Open", value: 1 }, { name: "Invalidated", value: 4 }],
    };
    const { model } = deriveStateBehavior({
      valueSets: [billing, leave],
      conditions: [],
      changes: [change({ field: "LeaveRequestStatus", fromValue: null, toValue: 4 })],
    });
    const state = model.facts.find((fact) => fact.kind === "state")!;
    expect(state.payload).toMatchObject({ valueSet: "LeaveRequestStatus", label: "Approved", value: 4 });
  });

  it("marks an unknown exact-set value unresolved instead of borrowing another enum", () => {
    const leave: ValueSet = {
      name: "LeaveRequestStatus",
      rootName: "svc",
      relPath: "leave.ts",
      startLine: 1,
      members: [{ name: "Pending", value: 1 }, { name: "Approved", value: 4 }],
    };
    const billing: ValueSet = {
      name: "BillingStatus",
      rootName: "svc",
      relPath: "billing.ts",
      startLine: 1,
      members: [{ name: "Open", value: 1 }, { name: "Invalidated", value: 7 }],
    };
    const { model, diagnostics } = deriveStateBehavior({
      valueSets: [leave, billing],
      conditions: [],
      changes: [change({ field: "LeaveRequestStatus", fromValue: null, toValue: 7 })],
    });
    expect(model.facts.some((fact) => fact.kind === "transition")).toBe(false);
    expect(diagnostics).toMatchObject([{ kind: "unresolved-target", field: "LeaveRequestStatus" }]);
  });

  it("uses the observer's declaration identity when two sets in one root have the same name", () => {
    const generic: ValueSet = {
      name: "StatusC",
      rootName: "svc",
      relPath: "status.go",
      startLine: 5,
      members: [{ name: "Active", value: 1 }, { name: "Deleted", value: 3 }],
    };
    const application: ValueSet = {
      name: "StatusC",
      rootName: "svc",
      relPath: "application.go",
      startLine: 60,
      members: [{ name: "Approved", value: 1 }, { name: "Completed", value: 2 }],
    };
    const { model } = deriveStateBehavior({
      valueSets: [application, generic],
      conditions: [],
      changes: [change({
        field: "StatusC",
        fromValue: null,
        toValue: 1,
        valueSet: { rootName: "svc", relPath: "status.go", startLine: 5, name: "StatusC" },
      })],
    });
    const state = model.facts.find((fact) => fact.kind === "state")!;
    expect(state.payload).toMatchObject({ valueSet: "StatusC", label: "Active", value: 1 });
    expect(state.evidence[0]!.provenance.source.relPath).toBe("status.go");
  });

  it("keeps two transitions between the same states that differ only by guard", () => {
    const { model } = deriveStateBehavior({
      valueSets: [set()],
      conditions: [],
      changes: [change({ guard: null }), change({ guard: "isOwner" })],
    });
    expect(model.facts.filter((f) => f.kind === "transition")).toHaveLength(2);
    expect(validateBehaviorModel(model).ok).toBe(true);
  });

  it("collapses an exact-duplicate change into one transition, keeping the model valid", () => {
    const { model } = deriveStateBehavior({
      valueSets: [set()],
      conditions: [],
      changes: [change(), change()],
    });
    expect(model.facts.filter((f) => f.kind === "transition")).toHaveLength(1);
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
  });

  it("produces a valid model for states plus a transition together", () => {
    const { model } = deriveStateBehavior({
      valueSets: [set()],
      conditions: [condition("leave.Status", 4)],
      changes: [change({ fromValue: 1, toValue: 2 })],
    });
    expect(validateBehaviorModel(model).ok).toBe(true);
    // the transition's endpoint states are among the facts (deduped with the condition-derived one)
    expect(model.facts.filter((f) => f.kind === "state").length).toBeGreaterThanOrEqual(2);
  });
});
