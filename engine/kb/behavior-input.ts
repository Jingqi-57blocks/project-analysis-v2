/**
 * The bridge from a run's extracted structural evidence to the behaviour derivers'
 * input (PI-20).
 *
 * The analysis extracts conditions, validations, auth annotations, error handling,
 * discarded errors, data access, transactions and outbound calls into the
 * structural model, but never fed them to the behaviour derivers — so a fresh run
 * derived no behaviour facts. This gathers the model into the derivers' input so
 * `assembleBehaviorModel` can run over a real analysis.
 *
 * It maps only the evidence the generic extraction already produces. Three behaviour
 * fact families the golden slice needs are not extracted anywhere yet and stay empty
 * here — notification calls, state transitions and test relations — each its own
 * generic-extractor sub-issue; a whitelist of names would not be a generic capability.
 */

import type { RootFacts } from "./extract.js";
import { gatherRecords } from "./gather.js";
import type { AssembleInput } from "./behavior-assemble.js";

/** Build the behaviour derivers' input from a run's extracted structural evidence. */
export function behaviorInputFrom(roots: readonly RootFacts[]): AssembleInput {
  const g = gatherRecords(roots);
  const valueSets = roots.flatMap((r) => r.valueSets);
  return {
    // Conditions and value sets are extracted; decisions/guards/business-rules are
    // not a separate structural kind, so they are empty (the deriver reads rules
    // from conditions).
    decisions: { conditions: g.conditions, decisions: [], guards: [], rules: [], valueSets },
    // State value sets and conditions are extracted; observed transitions (field →
    // value changes) are not — that extractor is a sub-issue.
    states: { valueSets, conditions: g.conditions },
    boundary: { auth: g.authAnnotations, validations: g.validations, errorHandling: g.errorHandling, discarded: g.discarded },
    // Data access, transactions and outbound calls are extracted; external-call and
    // notification-call classification is not — a sub-issue, not a name whitelist.
    sideEffects: { dataAccess: g.dataAccess, transactions: g.transactions, outbound: g.calls, external: [], notifications: [] },
    // Test relations are not linked yet — a sub-issue. providerRan false discloses it.
    tests: { testRelations: [], providerRan: false },
  };
}
