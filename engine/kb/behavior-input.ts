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
 * State transitions are observed generically from the source (PI-83): a value-set
 * member of a state-bearing set used in a write/value context is a change into
 * that state. Test relations (PI-84) are linked generically too: the reader in
 * engine/providers/tests takes the symbols and call edges the model already holds
 * and ties each test to the production code it calls — no per-project whitelist.
 */

import { stateRule } from "../semantics/rules.js";
import type { RootFacts } from "./extract.js";
import { gatherRecords } from "./gather.js";
import type { AssembleInput } from "./behavior-assemble.js";
import { deriveNotificationsForRoots } from "./notification-reachability.js";
import { observeStateChanges } from "./state-transition-observe.js";
import { deriveTestRelations } from "../providers/tests/provider.js";

/** Lexicographic string order, for deterministic per-root iteration. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

  // Observe state changes generically — a value-set member of a state-bearing set
  // used in a write/value context — so the state deriver has transitions to build.
  // Fails open per file; without root paths it scans nothing and adds only notes.
  const observed = observeStateChanges({
    roots,
    valueSets,
    conditions: g.conditions,
    ...(opts.rootPaths === undefined ? {} : { rootPaths: opts.rootPaths }),
  });

  // Link tests to the production code they exercise. The reader takes the model
  // view gatherRecords already built (symbols + call edges); SymbolId embeds the
  // root name, so partition per root and derive each independently. The reader is
  // part of every run now — providerRan is always true, so the gate can attest
  // coverage. A root with no indexed symbols is disclosed as a degraded index.
  const testNotes: string[] = [];
  const testRelations = [...roots]
    .sort((a, b) => cmp(a.rootName, b.rootName))
    .flatMap((root) => {
      const symbols = g.symbols
        .filter((s) => s.provenance.source.rootName === root.rootName)
        .sort((a, b) => cmp(a.id, b.id));
      if (symbols.length === 0) {
        testNotes.push(`test-relations: 0 symbols in ${root.rootName} — coverage cannot be confirmed`);
        return [];
      }
      const ids = new Set(symbols.map((s) => s.id));
      const callEdges = g.callEdges
        .filter((e) => ids.has(e.callerId))
        .sort(
          (a, b) =>
            cmp(a.callerId, b.callerId) ||
            cmp(a.calleeId ?? "", b.calleeId ?? "") ||
            cmp(a.calleeName, b.calleeName) ||
            (a.provenance.source.startLine ?? 0) - (b.provenance.source.startLine ?? 0),
        );
      return deriveTestRelations(root.rootName, { symbols, callEdges });
    });

  const input: AssembleInput = {
    decisions: { conditions: g.conditions, decisions: g.decisions, guards: g.guards, rules, valueSets },
    // State value sets and conditions are extracted; observed transitions (a field
    // set to an enum value in a write context) come from the generic observer.
    states: { valueSets, conditions: g.conditions, changes: observed.changes },
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
    // Test relations are linked generically (PI-84); the reader ran over every
    // root's model view, so providerRan is true (empty relations mean "found none",
    // not "never ran").
    tests: { testRelations, providerRan: true },
  };
  return { input, notes: [...reached.notes, ...observed.notes, ...testNotes] };
}
