/**
 * Deriving the behaviour model's decisions, conditions, rules and branch
 * outcomes from the logic and semantics records the engine already reads (PI-37).
 *
 * The logic provider reads if/switch trees, guards and discarded errors; the
 * semantics layer turns a comparison against a value set into a readable rule.
 * This is the adapter that lifts those engine-native records into the shared
 * behaviour contract (PI-62) — the same facts, in the envelope the store, query
 * and downstream milestones agree on — rather than a second condition/decision
 * reader. It invents nothing: every behaviour fact traces to exactly one source
 * record, and a decision's branches (including those that leave early, and those
 * nested inside another branch) all survive as related facts.
 *
 * What it does not do: guess a rule's meaning from a function's name, or promote a
 * log line or an error-constant symbol to a stated rule. Validation, auth and
 * error-handling facts are PI-39's; side effects are PI-12's.
 */

import type { EvidenceRecord, ProviderAttribution } from "../contracts/shared-fact/evidence.js";
import { factId, type FactId } from "../contracts/shared-fact/identity.js";
import { declared, inferred, lineRef, type Provenance } from "../contracts/shared-fact/provenance.js";
import {
  BEHAVIOR_SCHEMA_VERSION,
  type BehaviorActivation,
  type BehaviorFact,
  type BehaviorModel,
  type BehaviorPayload,
  type BehaviorRelation,
  type BehaviorScope,
} from "../contracts/behavior/schema.js";
import type { ConditionRecord, DecisionBranch, DecisionRecord, GuardRecord } from "../structural/rules.js";
import { type BusinessRule, isUnexplained } from "../semantics/rules.js";
import type { ValueSet } from "../semantics/enums.js";

const LOGIC: ProviderAttribution = { providerId: "logic", providerVersion: "1.0.0" };
const SEMANTICS: ProviderAttribution = { providerId: "semantics", providerVersion: "1.0.0" };

export interface BehaviorDeriveInput {
  readonly conditions: readonly ConditionRecord[];
  readonly decisions: readonly DecisionRecord[];
  readonly guards: readonly GuardRecord[];
  readonly rules: readonly BusinessRule[];
  readonly valueSets: readonly ValueSet[];
}

function ev(attribution: ProviderAttribution, provenance: Provenance): EvidenceRecord {
  return { attribution, provenance };
}

/**
 * A behaviour payload carries the two constrained fields plus whatever kind-
 * specific fields the fact needs. The schema fixes only scope and activation, so
 * this widens a richer literal back to the base type: the extra fields are kept at
 * runtime (and persisted verbatim), the contract is still satisfied.
 */
function pl<T extends BehaviorPayload>(payload: T): BehaviorPayload {
  return payload;
}

/** A fact scoped to its enclosing function is about that symbol; a top-level one is about its module. */
function scopeOf(enclosingFunction: string | null): BehaviorScope {
  return enclosingFunction !== null && enclosingFunction.length > 0 ? "symbol" : "module";
}

function conditionFact(c: ConditionRecord): BehaviorFact {
  const activation: BehaviorActivation = c.guarded === "rejects" ? "guarded" : "conditional";
  return {
    factId: factId({
      family: "behavioral",
      kind: "condition",
      discriminators: [c.rootName, c.source.relPath, String(c.source.startLine), c.subject, c.operator, String(c.literal)],
    }),
    family: "behavioral",
    kind: "condition",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(LOGIC, c.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(c.enclosingFunction),
      activation,
      subject: c.subject,
      operator: c.operator,
      literal: c.literal,
      text: c.text,
      fullTest: c.fullTest ?? null,
      guarded: c.guarded,
    }),
  };
}

function guardFact(g: GuardRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "guard",
      discriminators: [g.rootName, g.source.relPath, String(g.source.startLine), g.test],
    }),
    family: "behavioral",
    kind: "guard",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(LOGIC, g.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(g.enclosingFunction),
      activation: "guarded",
      test: g.test,
      // A stated message is the rule in the code's own words; an error-code names a
      // sentence that lives elsewhere, so it is kept apart, never quoted as prose.
      message: g.messageKind === "stated" ? g.message : null,
      errorCode: g.messageKind === "error-code" ? g.message : null,
    }),
  };
}

function valueSetFact(v: ValueSet): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "value-set",
      discriminators: [v.rootName, v.relPath, String(v.startLine), v.name],
    }),
    family: "behavioral",
    kind: "value-set",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(SEMANTICS, declared(lineRef(v.rootName, v.relPath, v.startLine)))],
    rawIdentities: [],
    payload: pl({ scope: "module", activation: "always", name: v.name, members: v.members }),
  };
}

function ruleFact(r: BusinessRule): BehaviorFact {
  // A rule is inferred — a comparison joined to a value set. Its confidence is
  // highest when a value set named the literal, lowest when nothing could explain
  // it; the unexplained rule is kept with its source fragment, not dropped.
  const confidence = isUnexplained(r) ? "low" : r.valueSetName !== null ? "high" : "medium";
  return {
    factId: factId({
      family: "behavioral",
      kind: "business-rule",
      discriminators: [r.rootName, r.relPath, String(r.startLine), r.subject, r.operator, String(r.literal)],
    }),
    family: "behavioral",
    kind: "business-rule",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(SEMANTICS, inferred(lineRef(r.rootName, r.relPath, r.startLine), confidence))],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(r.enclosingFunction),
      activation: r.guarded === "rejects" ? "guarded" : "conditional",
      statement: r.statement,
      subject: r.subject,
      operator: r.operator,
      literal: r.literal,
      text: r.text,
      meanings: r.meanings,
      valueSetName: r.valueSetName,
    }),
  };
}

function decisionId(d: DecisionRecord): FactId {
  return factId({
    family: "behavioral",
    kind: "decision",
    discriminators: [d.rootName, d.source.relPath, String(d.startLine), String(d.endLine), d.subject],
  });
}

/**
 * A decision, each of its branches as an own condition fact, and the relations
 * joining them. Recurses into decisions nested inside a branch so a branch's own
 * decisions are not lost. A decision with no branch is dropped — it is not a
 * decision the schema (or a reader) can make sense of.
 */
function deriveDecision(d: DecisionRecord, facts: BehaviorFact[], relations: BehaviorRelation[]): void {
  if (d.branches.length === 0) return;
  const id = decisionId(d);
  facts.push({
    factId: id,
    family: "behavioral",
    kind: "decision",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(LOGIC, d.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(d.enclosingFunction),
      activation: "conditional",
      subject: d.subject,
      kind: d.kind,
      truncated: d.truncated,
    }),
  });

  d.branches.forEach((branch: DecisionBranch, index: number) => {
    const branchFact: BehaviorFact = {
      factId: factId({
        family: "behavioral",
        kind: "condition",
        discriminators: [d.rootName, d.source.relPath, String(branch.startLine), String(index), branch.test],
      }),
      family: "behavioral",
      kind: "condition",
      schemaVersion: BEHAVIOR_SCHEMA_VERSION,
      evidence: [ev(LOGIC, d.provenance)],
      rawIdentities: [],
      payload: pl({
        scope: scopeOf(d.enclosingFunction),
        activation: branch.outcome === "leaves" ? "guarded" : "conditional",
        test: branch.test,
        outcome: branch.outcome,
        values: branch.values,
      }),
    };
    facts.push(branchFact);
    relations.push({ kind: "decision-branch", from: id, to: branchFact.factId, role: branch.outcome });

    for (const nested of branch.decisions) deriveDecision(nested, facts, relations);
  });
}

/**
 * Derive the decision/condition/rule slice of the behaviour model from the logic
 * and semantics records. Every fact traces to one source record; a rule that
 * reads a value set is linked to it. The result validates against the behaviour
 * contract by construction.
 */
export function deriveDecisionBehavior(input: BehaviorDeriveInput): BehaviorModel {
  const facts: BehaviorFact[] = [];
  const relations: BehaviorRelation[] = [];

  for (const c of input.conditions) facts.push(conditionFact(c));
  for (const g of input.guards) facts.push(guardFact(g));

  const valueSetIdByName = new Map<string, FactId>();
  for (const v of input.valueSets) {
    const fact = valueSetFact(v);
    facts.push(fact);
    if (!valueSetIdByName.has(v.name)) valueSetIdByName.set(v.name, fact.factId);
  }

  for (const r of input.rules) {
    const fact = ruleFact(r);
    facts.push(fact);
    if (r.valueSetName !== null) {
      const target = valueSetIdByName.get(r.valueSetName);
      if (target !== undefined) relations.push({ kind: "rule-valueset", from: fact.factId, to: target, role: "reads" });
    }
  }

  for (const d of input.decisions) deriveDecision(d, facts, relations);

  return { schemaVersion: BEHAVIOR_SCHEMA_VERSION, facts, relations };
}
