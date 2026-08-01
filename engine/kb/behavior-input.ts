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
import { deriveNotificationsForRoots } from "./notification-reachability.js";

/**
 * Where the code graph lives, and which root each name maps to, so the
 * notification-reachability deriver can read one shared index and scope it per
 * root. Both absent — a run without a code index, or the tests — is fine: the
 * deriver fails open and the input is exactly the extracted evidence.
 */
export interface BehaviorInputOptions {
  readonly codeIndexPath?: string | null;
  readonly rootPaths?: ReadonlyMap<string, string>;
}

/** The derivers' input, plus the notes the reachability pass disclosed (bounds it
 * hit, an absent or degraded index) so the caller can record them rather than let
 * a silent cap pass for full coverage. */
export interface BehaviorInput {
  readonly input: AssembleInput;
  readonly notes: readonly string[];
}

/** Build the behaviour derivers' input from a run's extracted structural evidence. */
export function behaviorInputFrom(
  roots: readonly RootFacts[],
  opts: BehaviorInputOptions = {},
): BehaviorInput {
  const g = gatherRecords(roots);
  const valueSets = roots.flatMap((r) => r.valueSets);
  // Conditions become business rules once value sets explain their values — the
  // same mapping the structural derive uses, so the two agree.
  const rules = g.conditions.map((condition) => stateRule(condition, valueSets));

  // Reverse-reach each standard send sink through the call graph and attribute a
  // notification-call to the functions that reach it, so the fact lands on the
  // handler, not only the send helper. Fails open: no index adds nothing.
  const reached = deriveNotificationsForRoots({
    sinks: g.notifications,
    ...(opts.codeIndexPath === undefined ? {} : { codeIndexPath: opts.codeIndexPath }),
    ...(opts.rootPaths === undefined ? {} : { rootPaths: opts.rootPaths }),
  });

  const input: AssembleInput = {
    decisions: { conditions: g.conditions, decisions: g.decisions, guards: g.guards, rules, valueSets },
    // State value sets and conditions are extracted; observed transitions (a field
    // set to an enum value) are not yet — that extractor is PI-83.
    states: { valueSets, conditions: g.conditions },
    boundary: { auth: g.authAnnotations, validations: g.validations, errorHandling: g.errorHandling, discarded: g.discarded },
    // Data access, transactions, outbound and notification calls are extracted;
    // no provider emits external-call, so it stays empty. The reverse-reachability
    // records join the directly-matched sinks under the same notification kind.
    sideEffects: {
      dataAccess: g.dataAccess,
      transactions: g.transactions,
      outbound: g.calls,
      external: [],
      notifications: [...g.notifications, ...reached.notifications],
    },
    // Test relations are not linked yet — PI-84. providerRan false discloses it.
    tests: { testRelations: [], providerRan: false },
  };
  return { input, notes: reached.notes };
}
