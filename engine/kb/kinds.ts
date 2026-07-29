/**
 * The kinds of derived fact, and how each one is identified.
 *
 * Same contract as `engine/structural/kinds.ts`: one bucket per kind, a
 * compile-time proof in both directions so a kind cannot exist without a
 * payload type or a payload type without a kind, and a deterministic key per
 * record so re-deriving the same conclusion produces the same row rather than
 * a second one.
 *
 * Keys matter more here than they look. A derivation runs over the whole
 * workspace, and two features, two flows or two rules that collide would merge
 * silently — the store would record one row where the analysis found two, and
 * nothing downstream could tell. So every key includes enough of what makes
 * the fact distinct to survive the ones that are genuinely near-identical: two
 * rules on one line, two flows through the same path in different features.
 */

import { joinKey } from "../structural/identity.js";
import type { BaseBinding } from "../linking/binding.js";
import type { CrossRootLink, UnlinkedCall } from "../linking/types.js";
import type { HealthSignal } from "../health/signals.js";
import type { StructuralFinding } from "../health/structure.js";
import type { TechnicalComponent } from "../modules/form.js";
import type { Trace } from "../modules/trace.js";
import type { BusinessRule } from "../semantics/rules.js";
import type { ValueSet } from "../semantics/enums.js";
import type {
  CoverageNote,
  FeatureFact,
  FeatureFindingFact,
  FeatureFlowFact,
  MapEdge,
  ModuleFact,
  RunContext,
} from "./facts.js";

export const DERIVED_KINDS = [
  "run-context",
  "feature",
  "feature-flow",
  "feature-finding",
  "business-rule",
  "value-set",
  "module",
  "component",
  "trace",
  "cross-root-link",
  "unlinked-call",
  "base-binding",
  "map-edge",
  "structural-finding",
  "health-signal",
  "coverage-note",
] as const;

export type DerivedKind = (typeof DERIVED_KINDS)[number];

export interface DerivedRecords {
  readonly "run-context": readonly RunContext[];
  readonly feature: readonly FeatureFact[];
  readonly "feature-flow": readonly FeatureFlowFact[];
  readonly "feature-finding": readonly FeatureFindingFact[];
  readonly "business-rule": readonly BusinessRule[];
  readonly "value-set": readonly ValueSet[];
  readonly module: readonly ModuleFact[];
  readonly component: readonly TechnicalComponent[];
  readonly trace: readonly Trace[];
  readonly "cross-root-link": readonly CrossRootLink[];
  readonly "unlinked-call": readonly UnlinkedCall[];
  readonly "base-binding": readonly BaseBinding[];
  readonly "map-edge": readonly MapEdge[];
  readonly "structural-finding": readonly StructuralFinding[];
  readonly "health-signal": readonly HealthSignal[];
  readonly "coverage-note": readonly CoverageNote[];
}

type MissingBucket = Exclude<DerivedKind, keyof DerivedRecords>;
type OrphanedBucket = Exclude<keyof DerivedRecords, DerivedKind>;
type _EveryKindHasABucket = MissingBucket extends never ? true : ["missing bucket for", MissingBucket];
type _EveryBucketHasAKind = OrphanedBucket extends never ? true : ["orphaned bucket", OrphanedBucket];
const _kindsMatchBuckets: [_EveryKindHasABucket, _EveryBucketHasAKind] = [true, true];
void _kindsMatchBuckets;

export function emptyDerived(): DerivedRecords {
  return {
    "run-context": [],
    feature: [],
    "feature-flow": [],
    "feature-finding": [],
    "business-rule": [],
    "value-set": [],
    module: [],
    component: [],
    trace: [],
    "cross-root-link": [],
    "unlinked-call": [],
    "base-binding": [],
    "map-edge": [],
    "structural-finding": [],
    "health-signal": [],
    "coverage-note": [],
  };
}

/**
 * A map rather than a switch, so the compiler requires an entry per kind.
 *
 * `run-context` is the one constant key: there is exactly one per snapshot,
 * and a second one would mean the run disagreed with itself about what it was.
 */
const KEY_BUILDERS: {
  readonly [K in DerivedKind]: (record: DerivedRecords[K][number]) => string;
} = {
  "run-context": () => "run",

  feature: (r) => r.id,

  // Keyed within its feature: two features can legitimately claim flows
  // through the same endpoint while the analysis is deciding which owns it,
  // and merging them would silently drop one feature's picture of itself.
  "feature-flow": (r) => joinKey([r.featureId, r.entryKey]),
  "feature-finding": (r) => joinKey([r.featureId, r.id]),

  // Location and the comparison both: a file can state the same rule twice,
  // and one line can carry two rules that differ only in their operator.
  "business-rule": (r) =>
    joinKey([r.rootName, r.relPath, r.startLine, r.subject, r.operator, String(r.literal)]),
  "value-set": (r) => joinKey([r.rootName, r.relPath, r.startLine, r.name]),

  module: (r) => r.id,
  component: (r) => r.id,

  trace: (r) => joinKey([r.entryRoot, r.entryKey]),

  // The call site, not the pair of roots: one caller can reach one route from
  // several places, and each is a separate observation of the integration.
  "cross-root-link": (r) =>
    joinKey([
      r.fromRoot,
      r.fromSymbolId,
      r.target,
      r.toRoot,
      r.toMethod,
      r.toPath,
      r.provenance.source.relPath,
      r.provenance.source.startLine,
    ]),
  "unlinked-call": (r) =>
    joinKey([
      r.fromRoot,
      r.fromSymbolId,
      r.target,
      r.reason,
      r.provenance.source.relPath,
      r.provenance.source.startLine,
    ]),
  "base-binding": (r) => joinKey([r.fromRoot, r.baseIdentifier]),

  "map-edge": (r) => joinKey([r.from, r.to, r.kind]),

  "structural-finding": (r) => r.id,
  "health-signal": (r) => r.id,

  // The note itself is part of its identity: one subject can carry several
  // limits, and keying on the subject alone would keep whichever was written
  // last and report a partial gap as the whole of it.
  "coverage-note": (r) => joinKey([r.subject, r.note]),
};

export function derivedKey<K extends DerivedKind>(
  kind: K,
  record: DerivedRecords[K][number],
): string {
  return KEY_BUILDERS[kind](record);
}

export function countDerived(records: DerivedRecords): number {
  return DERIVED_KINDS.reduce((total, kind) => total + records[kind].length, 0);
}

/**
 * A relationship between two facts, as stored.
 *
 * The far end may be a structural record — a feature's endpoints are routes,
 * which no derivation produced — so the kinds are plain strings on both sides
 * rather than a union of derived kinds only.
 */
export interface DerivedLink {
  readonly fromKind: DerivedKind;
  readonly fromKey: string;
  readonly role: string;
  readonly toKind: string;
  readonly toKey: string;
}
