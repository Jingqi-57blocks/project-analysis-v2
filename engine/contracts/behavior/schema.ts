/**
 * The behavior fact schema, relations and integrity constraints (PI-62).
 *
 * A behavior fact is a shared-fact `FactEnvelope` in the `behavioral` family — it
 * reuses the canonical identity, evidence and provenance rather than a parallel
 * model, and its kinds are exactly the migration matrix's `M2_FACT_KINDS`, not a
 * hand-copied second list. What this contract adds on top of the shared fact is
 * the M2-specific structure the derivers (PI-11/PI-12/PI-37/PI-38/PI-39/PI-40)
 * and the store (PI-63/PI-64) must agree on before any of them runs:
 *
 *   - a per-kind ownership split between PI-11 (behaviour semantics) and PI-12
 *     (side effects) that the matrix only states per unit, so the two never
 *     claim the same kind;
 *   - the relations between behaviour facts (a decision's branches, a
 *     transition's endpoint states, a rule's value set) and from a behaviour
 *     fact to a structural one (a guard's subject symbol/entity), keyed by
 *     canonical `FactId`, with their cardinality and a cycle rule;
 *   - the constraints every behaviour fact must satisfy — cited evidence with a
 *     legal resolution/confidence, a declared scope and an activation;
 *   - forward-compatible handling of an unknown/new kind: quarantined, its
 *     kind-specific shape left unjudged, never silently dropped.
 *
 * `entry`, `trace` and control-flow facts are structural/derived kinds owned by
 * PI-10 and the logic provider — a behaviour fact *references* them through a
 * relation, it does not redefine them here (the same "extend, don't parallel"
 * rule the vocabulary follows). It carries no report-audience or target-project
 * field: those belong to the report layer and to no fact.
 *
 * `BehaviorRelation` is the `FactId`-keyed form of engine/kb `DerivedLink`
 * (fromKind/fromKey/role/toKind/toKey); PI-63 persistence maps between the two.
 */

import type { FactEnvelope } from "../shared-fact/envelope.js";
import type { FactId } from "../shared-fact/identity.js";
import { validateProvenance } from "../shared-fact/provenance.js";
import { M2_FACT_KINDS } from "../migration/schema.js";

export const BEHAVIOR_SCHEMA_VERSION = "1.0.0";

/** The behaviour fact vocabulary is the matrix's M2 list — one source, no copy. */
export const BEHAVIOR_KINDS: readonly string[] = M2_FACT_KINDS;

/**
 * Who owns a kind's derivation. PI-11 owns the kinds whose subject is internal
 * business logic, values or state; PI-12 owns the kinds whose subject is a
 * boundary crossing or an external interaction; `test` (PI-40) owns the test
 * linkage. The three sets partition the vocabulary — that disjointness is what
 * keeps PI-11 and PI-12 from deriving the same kind twice.
 */
export type BehaviorOwner = "behavior-semantics" | "side-effect" | "test";

export const OWNER_ISSUE: { readonly [K in BehaviorOwner]: string } = {
  "behavior-semantics": "PI-11",
  "side-effect": "PI-12",
  test: "PI-40",
};

/** PI-11 — internal business logic, values and state. */
export const BEHAVIOR_SEMANTIC_KINDS: readonly string[] = [
  "condition",
  "decision",
  "guard",
  "discarded-error",
  "error-handling",
  "value-set",
  "business-rule",
  "validation-rule",
  "state",
  "transition",
];

/** PI-12 — boundary crossings and external interactions. */
export const SIDE_EFFECT_KINDS: readonly string[] = [
  "outbound-call",
  "data-access",
  "notification-call",
  "transaction-boundary",
  "auth-annotation",
];

/** PI-40 — the linkage between a test and what it exercises. */
export const TEST_KINDS: readonly string[] = ["test-relation"];

/** An owner paired with the kinds it claims. Parameterizable so the disjointness
 * check is exercisable with deliberately overlapping input, not only the constants. */
export type OwnerAssignment = readonly [BehaviorOwner, readonly string[]];
export const OWNER_LISTS: readonly OwnerAssignment[] = [
  ["behavior-semantics", BEHAVIOR_SEMANTIC_KINDS],
  ["side-effect", SIDE_EFFECT_KINDS],
  ["test", TEST_KINDS],
];

/** The owner of a kind, or "unknown" for a kind outside the M2 vocabulary. */
export function ownerOf(kind: string): BehaviorOwner | "unknown" {
  for (const [owner, kinds] of OWNER_LISTS) {
    if (kinds.includes(kind)) return owner;
  }
  return "unknown";
}

export type OwnershipValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * The ownership split is disjoint and total over the vocabulary. This is the
 * check that fails the moment a kind is assigned to two owners at once (PI-11/
 * PI-12 duplicate ownership) or to neither. The lists and vocabulary are
 * parameters so the rejection path is triggerable by input, not only by editing
 * the source constants.
 */
export function validateOwnership(
  lists: readonly OwnerAssignment[] = OWNER_LISTS,
  vocabulary: readonly string[] = BEHAVIOR_KINDS,
): OwnershipValidation {
  const reasons: string[] = [];
  const seen = new Map<string, BehaviorOwner>();
  for (const [owner, kinds] of lists) {
    for (const kind of kinds) {
      const prior = seen.get(kind);
      if (prior !== undefined && prior !== owner) {
        reasons.push(`kind ${kind} owned by both ${OWNER_ISSUE[prior]} and ${OWNER_ISSUE[owner]}`);
      }
      seen.set(kind, owner);
    }
  }
  for (const kind of vocabulary) {
    if (!seen.has(kind)) reasons.push(`M2 kind ${kind} has no owner`);
  }
  for (const kind of seen.keys()) {
    if (!vocabulary.includes(kind)) reasons.push(`owned kind ${kind} is not an M2 behaviour kind`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** Where a behaviour fact applies. Coarser than a location — a location is evidence. */
export type BehaviorScope = "symbol" | "module" | "entity" | "root" | "cross-root";
export const BEHAVIOR_SCOPES: readonly BehaviorScope[] = ["symbol", "module", "entity", "root", "cross-root"];

/** Whether the behaviour is unconditional or gated, so a report never overstates it. */
export type BehaviorActivation = "always" | "conditional" | "guarded" | "scheduled" | "unknown";
export const BEHAVIOR_ACTIVATIONS: readonly BehaviorActivation[] = [
  "always",
  "conditional",
  "guarded",
  "scheduled",
  "unknown",
];

/**
 * The fields every behaviour fact's payload carries beyond the envelope. Kinds
 * add their own fields on top; these are the ones the schema constrains.
 */
export interface BehaviorPayload {
  readonly scope: BehaviorScope;
  readonly activation: BehaviorActivation;
}

/** A behaviour fact: a shared-fact envelope in the behavioural family. */
export type BehaviorFact<T extends BehaviorPayload = BehaviorPayload> = FactEnvelope<T>;

export type BehaviorRelationKind =
  /** A decision to one of its branch outcomes. One decision, one-or-more branches. */
  | "decision-branch"
  /** A transition to an endpoint state. Exactly one from-state and one to-state. */
  | "transition-endpoint"
  /** A business rule to a value set it reads. Zero-or-more. */
  | "rule-valueset"
  /** A guard or validation rule to the subject it constrains — the one relation
   *  whose far end is a structural/derived fact rather than a behaviour fact. */
  | "guard-subject";

/**
 * The relation kinds whose far end is a structural/derived fact outside the
 * behaviour model, so its existence and kind are not checked against `model.facts`.
 */
const CROSS_FAMILY_RELATIONS: readonly BehaviorRelationKind[] = ["guard-subject"];

export interface BehaviorRelation {
  readonly kind: BehaviorRelationKind;
  readonly from: FactId;
  readonly to: FactId;
  /** The far end's role: "then"|"else"|"from-state"|"to-state"|"uses"|"constrains"|… */
  readonly role: string;
}

export interface BehaviorModel {
  readonly schemaVersion: string;
  readonly facts: readonly BehaviorFact[];
  readonly relations: readonly BehaviorRelation[];
}

/**
 * The derivation relations form a DAG: a rule cannot transitively read itself, a
 * decision cannot branch back into its own derivation. `transition-endpoint` is
 * excluded — a state machine's transitions legitimately cycle (A→B→A), and that
 * is a fact about the domain, not a broken reference.
 */
const ACYCLIC_RELATIONS: readonly BehaviorRelationKind[] = [
  "decision-branch",
  "rule-valueset",
  "guard-subject",
];

export type BehaviorValidation =
  | { readonly ok: true; readonly quarantined: readonly FactId[] }
  | { readonly ok: false; readonly reasons: readonly string[]; readonly quarantined: readonly FactId[] };

function hasCycle(edges: readonly (readonly [FactId, FactId])[]): boolean {
  const adjacency = new Map<FactId, FactId[]>();
  for (const [from, to] of edges) {
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  }
  const state = new Map<FactId, 1 | 2>(); // 1 = on stack, 2 = done
  const walk = (node: FactId): boolean => {
    const mark = state.get(node);
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(node, 1);
    for (const next of adjacency.get(node) ?? []) {
      if (walk(next)) return true;
    }
    state.set(node, 2);
    return false;
  };
  for (const node of adjacency.keys()) {
    if (walk(node)) return true;
  }
  return false;
}

/**
 * Integrity: unique ids; behavioural family; cited evidence with legal
 * provenance; for a known kind a declared scope and activation; relation
 * endpoints that exist and whose kinds fit the relation; transition/decision
 * cardinality; and no cycle through the derivation relations. A fact whose kind
 * is outside the M2 vocabulary is quarantined — reported and kept, its
 * kind-specific shape (scope/activation) left unjudged — so a new kind stays
 * forward-compatible instead of being dropped. Evidence is still required of it,
 * because a fact no report can cite is worthless whatever its kind.
 */
export function validateBehaviorModel(model: BehaviorModel): BehaviorValidation {
  const reasons: string[] = [];
  const quarantined: FactId[] = [];
  const byId = new Map<FactId, BehaviorFact>();

  const ownership = validateOwnership();
  if (!ownership.ok) reasons.push(...ownership.reasons);

  for (const fact of model.facts) {
    if (byId.has(fact.factId)) reasons.push(`duplicate behaviour fact id: ${fact.factId}`);
    byId.set(fact.factId, fact);

    if (fact.family !== "behavioral") reasons.push(`${fact.factId}: not in the behavioural family (${fact.family})`);
    const unknownKind = ownerOf(fact.kind) === "unknown";
    if (unknownKind) quarantined.push(fact.factId);

    if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) {
      reasons.push(`${fact.factId}: a behaviour fact must cite evidence`);
    } else {
      for (const record of fact.evidence) {
        const provenance = validateProvenance(record?.provenance);
        if (!provenance.ok) reasons.push(`${fact.factId}: bad provenance — ${provenance.reason}`);
      }
    }

    // A new kind may legitimately introduce a new scope/activation value; judging
    // its payload against this contract's enums would defeat the quarantine.
    if (!unknownKind) {
      const payload = (fact.payload ?? {}) as Partial<BehaviorPayload>;
      if (!BEHAVIOR_SCOPES.includes(payload.scope as BehaviorScope)) {
        reasons.push(`${fact.factId}: scope must be one of ${BEHAVIOR_SCOPES.join(", ")}`);
      }
      if (!BEHAVIOR_ACTIVATIONS.includes(payload.activation as BehaviorActivation)) {
        reasons.push(`${fact.factId}: activation must be one of ${BEHAVIOR_ACTIVATIONS.join(", ")}`);
      }
    }
  }

  const kindOf = (id: FactId): string | undefined => byId.get(id)?.kind;
  const transitionEndpoints = new Map<FactId, { from: number; to: number }>();
  const decisionBranchCount = new Map<FactId, number>();

  for (const relation of model.relations) {
    const crossFamily = CROSS_FAMILY_RELATIONS.includes(relation.kind);
    if (!byId.has(relation.from)) reasons.push(`relation ${relation.kind} from unknown fact ${relation.from}`);
    if (!crossFamily && !byId.has(relation.to)) reasons.push(`relation ${relation.kind} to unknown fact ${relation.to}`);
    if (relation.role.length === 0) reasons.push(`relation ${relation.kind} has no role`);

    switch (relation.kind) {
      case "decision-branch": {
        if (kindOf(relation.from) !== "decision") reasons.push(`decision-branch from ${relation.from} is not a decision`);
        decisionBranchCount.set(relation.from, (decisionBranchCount.get(relation.from) ?? 0) + 1);
        break;
      }
      case "transition-endpoint": {
        if (kindOf(relation.from) !== "transition") reasons.push(`transition-endpoint from ${relation.from} is not a transition`);
        if (kindOf(relation.to) !== "state") reasons.push(`transition-endpoint to ${relation.to} is not a state`);
        const tally = transitionEndpoints.get(relation.from) ?? { from: 0, to: 0 };
        if (relation.role === "from-state") tally.from += 1;
        else if (relation.role === "to-state") tally.to += 1;
        else reasons.push(`transition-endpoint ${relation.from} has role ${relation.role}, not from-state/to-state`);
        transitionEndpoints.set(relation.from, tally);
        break;
      }
      case "rule-valueset": {
        if (kindOf(relation.from) !== "business-rule") reasons.push(`rule-valueset from ${relation.from} is not a business-rule`);
        if (kindOf(relation.to) !== "value-set") reasons.push(`rule-valueset to ${relation.to} is not a value-set`);
        break;
      }
      case "guard-subject": {
        const from = kindOf(relation.from);
        if (from !== "guard" && from !== "validation-rule") {
          reasons.push(`guard-subject from ${relation.from} is not a guard or validation-rule`);
        }
        break;
      }
    }
  }

  // Cardinality is a property of the facts, not of the relations that happen to
  // exist: a transition with no endpoint relation at all is as wrong as one with
  // a single endpoint, and only a fact-driven check catches the orphan.
  for (const fact of model.facts) {
    if (fact.kind === "transition") {
      const tally = transitionEndpoints.get(fact.factId) ?? { from: 0, to: 0 };
      if (tally.from !== 1 || tally.to !== 1) {
        reasons.push(`transition ${fact.factId} needs exactly one from-state and one to-state, has from=${tally.from} to=${tally.to}`);
      }
    }
    if (fact.kind === "decision" && (decisionBranchCount.get(fact.factId) ?? 0) === 0) {
      reasons.push(`decision ${fact.factId} has no branch outcome`);
    }
  }

  const derivationEdges = model.relations
    .filter((r) => ACYCLIC_RELATIONS.includes(r.kind))
    .map((r): readonly [FactId, FactId] => [r.from, r.to]);
  if (hasCycle(derivationEdges)) reasons.push("derivation relations contain a cycle");

  return reasons.length === 0
    ? { ok: true, quarantined }
    : { ok: false, reasons, quarantined };
}
