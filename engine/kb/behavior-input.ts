/**
 * The bridge from a run's extracted structural evidence to the behaviour derivers'
 * input (PI-81).
 *
 * The analysis extracts the behaviour evidence — conditions, decisions, guards,
 * value sets, auth annotations, validations, error handling, discarded errors,
 * data access, transactions, outbound and notification calls — into the structural
 * model, but never fed them to the behaviour derivers, so a fresh run derived no
 * behaviour facts. This gathers the model into the derivers' input so
 * `assembleBehaviorModel` runs over a real analysis, and derives the business rules
 * from the conditions the same way the structural pipeline does.
 *
 * Two families the generic extraction does not produce yet stay empty here — state
 * transitions (PI-83) and test relations (PI-84) — each its own generic-extractor
 * sub-issue; a whitelist of names would not be a generic capability.
 */

import { stateRule } from "../semantics/rules.js";
import type { RootFacts } from "./extract.js";
import { gatherRecords } from "./gather.js";
import type { AssembleInput } from "./behavior-assemble.js";

/** Build the behaviour derivers' input from a run's extracted structural evidence. */
export function behaviorInputFrom(roots: readonly RootFacts[]): AssembleInput {
  const g = gatherRecords(roots);
  const valueSets = roots.flatMap((r) => r.valueSets);
  // Conditions become business rules once value sets explain their values — the
  // same mapping the structural derive uses, so the two agree.
  const rules = g.conditions.map((condition) => stateRule(condition, valueSets));
  return {
    decisions: { conditions: g.conditions, decisions: g.decisions, guards: g.guards, rules, valueSets },
    // State value sets and conditions are extracted; observed transitions (a field
    // set to an enum value) are not yet — that extractor is PI-83.
    states: { valueSets, conditions: g.conditions },
    boundary: { auth: g.authAnnotations, validations: g.validations, errorHandling: g.errorHandling, discarded: g.discarded },
    // Data access, transactions, outbound and notification calls are extracted;
    // no provider emits external-call, so it stays empty.
    sideEffects: { dataAccess: g.dataAccess, transactions: g.transactions, outbound: g.calls, external: [], notifications: g.notifications },
    // Test relations are not linked yet — PI-84. providerRan false discloses it.
    tests: { testRelations: [], providerRan: false },
  };
}
