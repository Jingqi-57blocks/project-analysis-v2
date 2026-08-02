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
 * A *transition* needs a to-state, a trigger and (optionally) a from-state and a
 * guard. Those come from observed state changes — an assignment, a database
 * write, an event publish — supplied by the caller. When both ends resolve the
 * transition carries both endpoints; when only the target resolves it is emitted
 * with a lone to-state and an undeterminable-start note, the honest shape for a
 * change whose origin the code does not state. Only when the target itself
 * resolves to no known state is nothing emitted — that is a diagnostic alone.
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
  /** Exact declaration identity when the source observer resolved a member. */
  readonly valueSet?: Pick<ValueSet, "rootName" | "relPath" | "startLine" | "name">;
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
    discriminators: [set.rootName, set.relPath, String(set.startLine), set.name, member.name, String(member.value), typeof member.value],
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
 * An observer-produced field is the value-set name itself. Resolve that exact
 * identity before applying the fuzzy subject matcher used for ordinary fields
 * such as `leave.Status`. If the exact set exists but cannot explain the value,
 * the change is unresolved; a numerically equal member of another enum must not
 * silently replace it.
 */
function resolveStateValue(
  subject: string,
  value: number | string,
  sets: readonly ValueSet[],
  rootName: string,
  identity?: Pick<ValueSet, "rootName" | "relPath" | "startLine" | "name">,
): { set: ValueSet; member: ValueSetMember } | null {
  const exact = identity === undefined
    ? sets.find((set) => set.rootName === rootName && set.name === subject)
    : sets.find((set) =>
        set.rootName === identity.rootName &&
        set.relPath === identity.relPath &&
        set.startLine === identity.startLine &&
        set.name === identity.name,
      );
  if (exact !== undefined) {
    const member = exact.members.find((candidate) => candidate.value === value);
    return member === undefined ? null : { set: exact, member };
  }
  if (identity !== undefined) return null;
  return resolveValue(subject, value, sets, rootName);
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
  const seenTransitions = new Set<FactId>();

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
    const to = resolveStateValue(change.field, change.toValue, input.valueSets, change.rootName, change.valueSet);
    const from = change.fromValue === null ? null : resolveStateValue(change.field, change.fromValue, input.valueSets, change.rootName, change.valueSet);

    if (to === null) {
      diagnostics.push({
        kind: change.fromValue !== null && from === null ? "unresolved-both" : "unresolved-target",
        field: change.field,
        detail: `change to ${String(change.toValue)} on ${change.field} resolves to no known state (trigger ${change.trigger})`,
      });
      continue;
    }
    // The target is a real state; the start may not be. A `fromValue` of null, or
    // one that resolves to no known state, still leaves a genuine change *into*
    // `to` — emitted as a to-only transition rather than dropped or given a
    // fabricated origin. The undeterminable-start note is kept alongside it so the
    // missing start stays auditable, and `fromName` falls back to the empty-string
    // discriminator identity already reserves for an absent endpoint.
    const startResolved = change.fromValue !== null && from !== null;
    if (!startResolved) {
      diagnostics.push({
        kind: "undeterminable-start",
        field: change.field,
        detail: `a change to ${to.member.name} on ${change.field} has no determinable start state (trigger ${change.trigger})`,
      });
    }
    const fromName = startResolved ? from!.member.name : "";

    const transitionFactId = factId({
      family: "behavioral",
      kind: "transition",
      // guard is part of identity — two transitions between the same states from
      // the same trigger but under different guards are different transitions.
      discriminators: [
        change.rootName, change.field, fromName, to.member.name,
        change.trigger, String(change.source.startLine), change.guard ?? "",
      ],
    });
    // An exact-duplicate observation (a caller emitting the same change twice)
    // collapses to one transition rather than a duplicate id the model rejects.
    if (seenTransitions.has(transitionFactId)) continue;
    seenTransitions.add(transitionFactId);

    const toId = claimState(to.set, to.member);
    const transition: BehaviorFact = {
      factId: transitionFactId,
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
    if (startResolved) {
      const fromId = claimState(from!.set, from!.member);
      relations.push({ kind: "transition-endpoint", from: transition.factId, to: fromId, role: "from-state" });
    }
    relations.push({ kind: "transition-endpoint", from: transition.factId, to: toId, role: "to-state" });
  }

  return { model: { schemaVersion: BEHAVIOR_SCHEMA_VERSION, facts, relations }, diagnostics };
}
