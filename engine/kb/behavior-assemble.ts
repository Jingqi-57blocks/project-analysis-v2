/**
 * Assembling the integrated behaviour model (PI-13).
 *
 * PI-11's derivers (decisions/conditions/rules, states/transitions, auth/
 * validation/errors, test relations) and PI-12's side-effect deriver each own a
 * disjoint slice of the behaviour vocabulary. This converges them into one
 * `BehaviorModel` — the integrated dataset the store persists (PI-63), the query
 * layer serves (PI-64) and the truth gate grades (PI-67) — without re-extracting
 * anything or letting one fact be produced twice.
 *
 * Convergence is by canonical id: a fact id is written once. Because the derivers
 * own disjoint kinds a cross-deriver id collision should never happen, so one is
 * recorded as a diagnostic rather than silently dropped — it would signal an
 * ownership leak. The merged model is validated as a whole (ownership disjoint,
 * relation cardinality, no cycle); an invalid integration fails closed rather than
 * persisting a model the gate cannot trust.
 */

import {
  type BehaviorFact,
  type BehaviorModel,
  type BehaviorRelation,
  validateBehaviorModel,
} from "../contracts/behavior/schema.js";
import { type BehaviorDeriveInput, deriveDecisionBehavior } from "./behavior-derive.js";
import { type BehaviorStateInput, deriveStateBehavior } from "./state-derive.js";
import { type BoundaryDeriveInput, deriveBoundaryBehavior } from "./boundary-derive.js";
import { type SideEffectDeriveInput, deriveSideEffectBehavior } from "./sideeffect-derive.js";
import { type TestBehaviorInput, type TestCoverage, deriveTestBehavior } from "./test-derive.js";

export interface AssembleInput {
  readonly decisions: BehaviorDeriveInput;
  readonly states: BehaviorStateInput;
  readonly boundary: BoundaryDeriveInput;
  readonly sideEffects: SideEffectDeriveInput;
  readonly tests: TestBehaviorInput;
}

export interface AssembledBehavior {
  readonly model: BehaviorModel;
  /** State-transition and cross-deriver notes — what could not be placed. */
  readonly diagnostics: readonly string[];
  /** Whether the test-relation reader ran, kept distinct from finding nothing. */
  readonly testCoverage: TestCoverage;
}

/**
 * Run every deriver and converge their facts and relations into one validated
 * model. Facts merge by id (a collision across derivers is diagnosed, not
 * dropped); relations merge by their full shape. Throws if the integrated model
 * does not satisfy the behaviour contract — a bad integration must not persist.
 */
export function assembleBehaviorModel(input: AssembleInput): AssembledBehavior {
  const state = deriveStateBehavior(input.states);
  const test = deriveTestBehavior(input.tests);
  const parts: readonly { source: string; model: BehaviorModel }[] = [
    { source: "decisions", model: deriveDecisionBehavior(input.decisions) },
    { source: "states", model: state.model },
    { source: "boundary", model: deriveBoundaryBehavior(input.boundary) },
    { source: "side-effects", model: deriveSideEffectBehavior(input.sideEffects) },
    { source: "tests", model: test.model },
  ];

  const factById = new Map<string, { source: string; fact: BehaviorFact }>();
  const diagnostics: string[] = state.diagnostics.map(
    (d) => `state:${d.kind} on ${d.field}: ${d.detail}`,
  );

  for (const part of parts) {
    for (const fact of part.model.facts) {
      const existing = factById.get(fact.factId);
      if (existing !== undefined) {
        if (existing.source !== part.source) {
          diagnostics.push(
            `fact ${fact.factId} produced by both ${existing.source} and ${part.source} — ownership overlap`,
          );
        }
        continue; // written once, first-source wins
      }
      factById.set(fact.factId, { source: part.source, fact });
    }
  }

  const relationSeen = new Set<string>();
  const relations: BehaviorRelation[] = [];
  for (const part of parts) {
    for (const relation of part.model.relations) {
      const key = `${relation.kind}\0${relation.from}\0${relation.to}\0${relation.role}`;
      if (relationSeen.has(key)) continue;
      relationSeen.add(key);
      relations.push(relation);
    }
  }

  const model: BehaviorModel = {
    schemaVersion: parts[0]!.model.schemaVersion,
    facts: [...factById.values()].map((v) => v.fact),
    relations,
  };

  const validation = validateBehaviorModel(model);
  if (!validation.ok) {
    throw new Error(`integrated behaviour model is invalid: ${validation.reasons.join("; ")}`);
  }

  return { model, diagnostics, testCoverage: test.coverage };
}
