import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../../engine/contracts/shared-fact/evidence.js";
import { factId } from "../../../engine/contracts/shared-fact/identity.js";
import { lineRef } from "../../../engine/contracts/shared-fact/provenance.js";
import {
  BEHAVIOR_KINDS,
  BEHAVIOR_SEMANTIC_KINDS,
  SIDE_EFFECT_KINDS,
  type BehaviorFact,
  type BehaviorModel,
  type BehaviorPayload,
  ownerOf,
  validateBehaviorModel,
  validateOwnership,
} from "../../../engine/contracts/behavior/schema.js";

const evidence: EvidenceRecord = {
  attribution: { providerId: "logic", providerVersion: "1.0.0" },
  provenance: { resolutionClass: "resolved", source: lineRef("svc", "a.go", 3), confidence: "high" },
};

function fact(
  kind: string,
  disc: string,
  overrides: { family?: BehaviorFact["family"]; payload?: Partial<BehaviorPayload>; evidence?: readonly EvidenceRecord[] } = {},
): BehaviorFact {
  const family = overrides.family ?? "behavioral";
  return {
    factId: factId({ family, kind, discriminators: [disc] }),
    family,
    kind,
    schemaVersion: "1.0.0",
    evidence: overrides.evidence ?? [evidence],
    rawIdentities: [],
    payload: { scope: "symbol", activation: "always", ...overrides.payload },
  };
}

const stateA = fact("state", "A");
const stateB = fact("state", "B");
const trans = fact("transition", "A->B");
const rule = fact("business-rule", "r1");
const vset = fact("value-set", "statuses");
const decision = fact("decision", "d1");
const branch = fact("condition", "c1");

function endpoints(): BehaviorModel {
  return {
    schemaVersion: "1.0.0",
    facts: [stateA, stateB, trans, rule, vset, decision, branch],
    relations: [
      { kind: "transition-endpoint", from: trans.factId, to: stateA.factId, role: "from-state" },
      { kind: "transition-endpoint", from: trans.factId, to: stateB.factId, role: "to-state" },
      { kind: "rule-valueset", from: rule.factId, to: vset.factId, role: "uses" },
      { kind: "decision-branch", from: decision.factId, to: branch.factId, role: "then" },
    ],
  };
}

describe("ownership (PI-11 vs PI-12)", () => {
  it("partitions the M2 vocabulary with no kind owned twice or left unowned", () => {
    expect(validateOwnership()).toEqual({ ok: true });
  });

  it("keeps behaviour-semantics and side-effect kinds disjoint", () => {
    const overlap = BEHAVIOR_SEMANTIC_KINDS.filter((k) => SIDE_EFFECT_KINDS.includes(k));
    expect(overlap).toEqual([]);
  });

  it("assigns every M2 kind an owner and unknown kinds none", () => {
    for (const kind of BEHAVIOR_KINDS) expect(ownerOf(kind)).not.toBe("unknown");
    expect(ownerOf("teleport")).toBe("unknown");
  });
});

describe("validateBehaviorModel", () => {
  it("accepts a well-formed model", () => {
    expect(validateBehaviorModel(endpoints())).toEqual({ ok: true, quarantined: [] });
  });

  it("accepts a minimal single-fact model", () => {
    const r = validateBehaviorModel({ schemaVersion: "1.0.0", facts: [fact("condition", "c")], relations: [] });
    expect(r.ok).toBe(true);
  });

  it("quarantines an unknown kind rather than dropping or failing", () => {
    const unknown = fact("teleport", "x");
    const r = validateBehaviorModel({ schemaVersion: "1.0.0", facts: [unknown], relations: [] });
    expect(r.ok).toBe(true);
    expect(r.quarantined).toEqual([unknown.factId]);
  });

  it("rejects a fact outside the behavioural family", () => {
    const r = validateBehaviorModel({ schemaVersion: "1.0.0", facts: [fact("state", "X", { family: "structural" })], relations: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("behavioural family");
  });

  it("rejects a fact that cites no evidence", () => {
    const r = validateBehaviorModel({ schemaVersion: "1.0.0", facts: [fact("guard", "g", { evidence: [] })], relations: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("must cite evidence");
  });

  it("rejects illegal provenance — an inferred fact with no confidence", () => {
    const bad: EvidenceRecord = {
      attribution: { providerId: "logic", providerVersion: "1.0.0" },
      provenance: { resolutionClass: "inferred", source: lineRef("svc", "a.go", 1) } as unknown as EvidenceRecord["provenance"],
    };
    const r = validateBehaviorModel({ schemaVersion: "1.0.0", facts: [fact("decision", "d", { evidence: [bad] })], relations: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("bad provenance");
  });

  it("rejects a fact with no scope or activation", () => {
    const noPayload: BehaviorFact = { ...fact("decision", "d"), payload: {} as unknown as BehaviorPayload };
    const r = validateBehaviorModel({ schemaVersion: "1.0.0", facts: [noPayload], relations: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons.join()).toContain("scope must be");
      expect(r.reasons.join()).toContain("activation must be");
    }
  });

  it("rejects a relation endpoint that is not a fact", () => {
    const ghost = factId({ family: "behavioral", kind: "state", discriminators: ["ghost"] });
    const r = validateBehaviorModel({
      schemaVersion: "1.0.0",
      facts: [trans, stateA, stateB],
      relations: [
        { kind: "transition-endpoint", from: trans.factId, to: stateA.factId, role: "from-state" },
        { kind: "transition-endpoint", from: trans.factId, to: ghost, role: "to-state" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("unknown fact");
  });

  it("rejects a transition endpoint that is not a state", () => {
    const r = validateBehaviorModel({
      schemaVersion: "1.0.0",
      facts: [trans, stateA, rule],
      relations: [
        { kind: "transition-endpoint", from: trans.factId, to: stateA.factId, role: "from-state" },
        { kind: "transition-endpoint", from: trans.factId, to: rule.factId, role: "to-state" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("not a state");
  });

  it("rejects a transition without exactly one from-state and one to-state", () => {
    const r = validateBehaviorModel({
      schemaVersion: "1.0.0",
      facts: [trans, stateA],
      relations: [{ kind: "transition-endpoint", from: trans.factId, to: stateA.factId, role: "from-state" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("exactly one from-state and one to-state");
  });

  it("rejects a decision with no branch outcome", () => {
    const r = validateBehaviorModel({ schemaVersion: "1.0.0", facts: [decision], relations: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("no branch outcome");
  });

  it("rejects a rule-valueset whose target is not a value-set", () => {
    const r = validateBehaviorModel({
      schemaVersion: "1.0.0",
      facts: [rule, stateA],
      relations: [{ kind: "rule-valueset", from: rule.factId, to: stateA.factId, role: "uses" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("not a value-set");
  });

  it("rejects a cycle through derivation relations", () => {
    const g1 = fact("guard", "g1");
    const g2 = fact("guard", "g2");
    const r = validateBehaviorModel({
      schemaVersion: "1.0.0",
      facts: [g1, g2],
      relations: [
        { kind: "guard-subject", from: g1.factId, to: g2.factId, role: "constrains" },
        { kind: "guard-subject", from: g2.factId, to: g1.factId, role: "constrains" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("cycle");
  });

  it("allows a self-cyclic state machine — a transition back to its own source", () => {
    const selfTrans = fact("transition", "A->A");
    const r = validateBehaviorModel({
      schemaVersion: "1.0.0",
      facts: [selfTrans, stateA],
      relations: [
        { kind: "transition-endpoint", from: selfTrans.factId, to: stateA.factId, role: "from-state" },
        { kind: "transition-endpoint", from: selfTrans.factId, to: stateA.factId, role: "to-state" },
      ],
    });
    expect(r.ok).toBe(true);
  });
});
