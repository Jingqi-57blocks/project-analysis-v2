/**
 * Deriving object states and state transitions (PI-38), net-new on top of the
 * existing value-set derivation.
 *
 * A value set on its own is a vocabulary, not a state machine — a project has
 * many enums that never model a lifecycle. A member becomes a *state* only when
 * the code is seen to compare a field against it: that usage is the evidence a
 * value is a status, so an ordinary field's constants are never promoted to a
 * business state machine. Value resolution itself is reused from
 * `engine/semantics/enums.ts` (`resolveValue`), not re-implemented.
 *
 * A *transition* needs a from-state, a to-state, a trigger and (optionally) a
 * guard. Those come from observed state changes — an assignment, a database
 * write, an event publish — supplied by the caller. When both ends resolve to a
 * state the transition is emitted with its endpoints; when the start cannot be
 * determined, or the target resolves to no known state, the transition is not
 * invented — it is returned as an explicit unresolved diagnostic.
 */

import type { EvidenceRecord, ProviderAttribution } from "../contracts/shared-fact/evidence.js";
import { factId, type FactId } from "../contracts/shared-fact/identity.js";
import { declared, lineRef, type Provenance, type SourceRef } from "../contracts/shared-fact/provenance.js";
import {
  BEHAVIOR_SCHEMA_VERSION,
  type BehaviorFact,
  type BehaviorModel,
  type BehaviorPayload,
  type BehaviorRelation,
} from "../contracts/behavior/schema.js";
import type { ConditionRecord } from "../structural/rules.js";
import { resolveValue, type ValueSet, type ValueSetMember } from "../semantics/enums.js";

const SEMANTICS: ProviderAttribution = { providerId: "semantics", providerVersion: "1.0.0" };

/** An observed change of a field's value — the evidence a transition is built from. */
export interface StateChangeObservation {
  readonly rootName: string;
  /** The field whose value changes, as written: `lv.Status`. */
  readonly field: string;
  /** The value required before the change, or null when the start is not stated. */
  readonly fromValue: number | string | null;
  readonly toValue: number | string;
  /** What causes the change — an entry point, a handler, an event. */
  readonly trigger: string;
  readonly guard: string | null;
  readonly source: SourceRef;
}

export interface BehaviorStateInput {
  readonly valueSets: readonly ValueSet[];
  /** Comparisons observed in code; a value compared here is a status, not just a constant. */
  readonly conditions: readonly ConditionRecord[];
  readonly changes?: readonly StateChangeObservation[];
}

export type StateDiagnosticKind = "unresolved-target" | "undeterminable-start" | "unresolved-both";

export interface StateDiagnostic {
  readonly kind: StateDiagnosticKind;
  readonly field: string;
  readonly detail: string;
}

export interface BehaviorStateResult {
  readonly model: BehaviorModel;
  /** Transitions that could not be fully placed — recorded, never dropped. */
  readonly diagnostics: readonly StateDiagnostic[];
}

function ev(provenance: Provenance): EvidenceRecord {
  return { attribution: SEMANTICS, provenance };
}

function pl<T extends BehaviorPayload>(payload: T): BehaviorPayload {
  return payload;
}

function stateId(set: ValueSet, member: ValueSetMember): FactId {
  return factId({
    family: "behavioral",
    kind: "state",
    discriminators: [set.rootName, set.relPath, set.name, member.name, String(member.value), typeof member.value],
  });
}

function stateFact(set: ValueSet, member: ValueSetMember): BehaviorFact {
  return {
    factId: stateId(set, member),
    family: "behavioral",
    kind: "state",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(declared(lineRef(set.rootName, set.relPath, set.startLine)))],
    rawIdentities: [],
    payload: pl({
      scope: "entity",
      activation: "always",
      valueSet: set.name,
      label: member.name,
      value: member.value,
    }),
  };
}

/**
 * Derive states and transitions. States come from value-set members the code
 * compares against; transitions come from observed changes, with the ones that
 * cannot be fully resolved returned as diagnostics.
 */
export function deriveStateBehavior(input: BehaviorStateInput): BehaviorStateResult {
  const facts: BehaviorFact[] = [];
  const relations: BehaviorRelation[] = [];
  const diagnostics: StateDiagnostic[] = [];
  const stateByKey = new Map<FactId, BehaviorFact>();

  const claimState = (set: ValueSet, member: ValueSetMember): FactId => {
    const id = stateId(set, member);
    if (!stateByKey.has(id)) {
      const fact = stateFact(set, member);
      stateByKey.set(id, fact);
      facts.push(fact);
    }
    return id;
  };

  // A member is a state exactly when a condition compares its field against it.
  for (const condition of input.conditions) {
    const resolved = resolveValue(condition.subject, condition.literal, input.valueSets, condition.rootName);
    if (resolved !== null) claimState(resolved.set, resolved.member);
  }

  for (const change of input.changes ?? []) {
    const to = resolveValue(change.field, change.toValue, input.valueSets, change.rootName);
    const from = change.fromValue === null ? null : resolveValue(change.field, change.fromValue, input.valueSets, change.rootName);

    if (to === null) {
      diagnostics.push({
        kind: change.fromValue !== null && from === null ? "unresolved-both" : "unresolved-target",
        field: change.field,
        detail: `change to ${String(change.toValue)} on ${change.field} resolves to no known state (trigger ${change.trigger})`,
      });
      continue;
    }
    if (change.fromValue === null || from === null) {
      // The target is a real state but the start is not determinable: a possible
      // transition, recorded rather than asserted with a fabricated from-state.
      diagnostics.push({
        kind: "undeterminable-start",
        field: change.field,
        detail: `a change to ${to.member.name} on ${change.field} has no determinable start state (trigger ${change.trigger})`,
      });
      continue;
    }

    const fromId = claimState(from.set, from.member);
    const toId = claimState(to.set, to.member);
    const transition: BehaviorFact = {
      factId: factId({
        family: "behavioral",
        kind: "transition",
        discriminators: [change.rootName, change.field, from.member.name, to.member.name, change.trigger, String(change.source.startLine)],
      }),
      family: "behavioral",
      kind: "transition",
      schemaVersion: BEHAVIOR_SCHEMA_VERSION,
      evidence: [ev(declared(change.source))],
      rawIdentities: [],
      payload: pl({
        scope: "entity",
        activation: change.guard !== null ? "guarded" : "always",
        field: change.field,
        trigger: change.trigger,
        guard: change.guard,
      }),
    };
    facts.push(transition);
    relations.push({ kind: "transition-endpoint", from: transition.factId, to: fromId, role: "from-state" });
    relations.push({ kind: "transition-endpoint", from: transition.factId, to: toId, role: "to-state" });
  }

  return { model: { schemaVersion: BEHAVIOR_SCHEMA_VERSION, facts, relations }, diagnostics };
}
