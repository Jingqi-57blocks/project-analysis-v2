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
import { observeAuthorization, promoteGuardValidations } from "./boundary-observe.js";
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

  // Observe authorization generically — a role value-set member read in a comparison
  // or handed to a call is a permission gate — so the boundary deriver has genuine
  // auth-annotation facts for the imperative role checks. Fails open per file.
  const observedAuth = observeAuthorization({
    roots,
    valueSets,
    ...(opts.rootPaths === undefined ? {} : { rootPaths: opts.rootPaths }),
  });

  // Link tests to the production code they exercise. The reader takes the model
  // view gatherRecords already built (symbols + call edges); SymbolId embeds the
  // root name, so partition per root and derive each independently.
  //
  // Coverage is only confirmable when the reader genuinely ran over a populated
  // index: at least one analyzed root, and every analyzed root produced ≥1 symbol.
  // A root with zero symbols is a degraded/stale/missing index — the reader saw
  // nothing and so cannot attest a test is absent. That withholds the coverage
  // receipt (providerRan false → coverage "not-run"), and the gate fails closed
  // rather than certifying a false absence off an index it never really read.
  const testNotes: string[] = [];
  const sortedRoots = [...roots].sort((a, b) => cmp(a.rootName, b.rootName));
  let coverageConfirmable = true;
  const testRelations = sortedRoots.flatMap((root) => {
    const symbols = g.symbols
      .filter((s) => s.provenance.source.rootName === root.rootName)
      .sort((a, b) => cmp(a.id, b.id));
    if (symbols.length === 0) {
      testNotes.push(`test-relations: 0 symbols in ${root.rootName} — coverage cannot be confirmed`);
      coverageConfirmable = false;
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
          (a.provenance.source.startLine ?? 0) - (b.provenance.source.startLine ?? 0) ||
          cmp(a.provenance.source.relPath, b.provenance.source.relPath) ||
          (a.provenance.source.startColumn ?? 0) - (b.provenance.source.startColumn ?? 0),
      );
    return deriveTestRelations(root.rootName, { symbols, callEdges });
  });
  const testProviderRan = sortedRoots.length > 0 && coverageConfirmable;

  const input: AssembleInput = {
    decisions: { conditions: g.conditions, decisions: g.decisions, guards: g.guards, rules, valueSets },
    // State value sets and conditions are extracted; observed transitions (a field
    // set to an enum value in a write context) come from the generic observer.
    states: { valueSets, conditions: g.conditions, changes: observed.changes },
    // Auth and validations join the conventions-extracted records with the ones
    // observed from imperative signals (PI-86): role-membership checks and guards
    // that reject with a stated message. deriveBoundaryBehavior dedups by factId, so
    // overlap with an existing record is harmless.
    boundary: {
      auth: [...g.authAnnotations, ...observedAuth.auth],
      validations: [...g.validations, ...promoteGuardValidations(g.guards)],
      errorHandling: g.errorHandling,
      discarded: g.discarded,
    },
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
    // Test relations are linked generically (PI-84). providerRan is true only when
    // the reader ran over a populated index for every root (see above); an empty
    // relation set then means "found none", while a withheld receipt means the
    // index could not be trusted to have shown them.
    tests: { testRelations, providerRan: testProviderRan },
  };
  return { input, notes: [...reached.notes, ...observed.notes, ...observedAuth.notes, ...testNotes] };
}
