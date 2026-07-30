/**
 * The model's record kinds, and how to read an empty one.
 *
 * Emptiness is ambiguous by nature: no routes could mean the project serves
 * none, or that nothing looked. Capability declarations resolve that per
 * provider, but a consumer also needs to know which kinds are *expected* at
 * all, so the split below exists to keep a report from treating a normal
 * absence as a finding.
 */

import type {
  CallEdgeRecord,
  ExportRecord,
  ImportRecord,
  ReferenceRecord,
  SourceFileRecord,
  SymbolRecord,
  TypeRelationRecord,
} from "./code.js";
import type {
  BuildTargetRecord,
  ModuleContainmentRecord,
  PackageDependencyRecord,
} from "./dependencies.js";
import type {
  AuthAnnotationRecord,
  DataAccessRecord,
  ExternalCallRecord,
  OutboundCallRecord,
  RouteRecord,
  TestRelationRecord,
} from "./boundaries.js";
import type {
  ErrorHandlingRecord,
  ConditionRecord,
  GuardRecord,
  NotificationCallRecord,
  ScheduledTaskRecord,
  DecisionRecord,
  DiscardedErrorRecord,
  TransactionBoundaryRecord,
  ValidationRuleRecord,
} from "./rules.js";
import type {
  ConstraintRecord,
  DataRelationRecord,
  EntityRecord,
  FieldRecord,
} from "../datamodel/types.js";

/**
 * Kinds that fall out of code structure itself, in any language.
 *
 * An empty result here is weak evidence of a *gap* rather than a property:
 * a codebase with source files but no symbols means something failed to parse,
 * not that the code has no functions.
 */
export const UNIVERSAL_KINDS = [
  "source-file",
  "symbol",
  "call-edge",
  "import",
  "export",
  "reference",
  "type-relation",
  "module-containment",
] as const;

/**
 * Kinds that depend on the project actually doing the thing.
 *
 * An empty result here is ordinary. A library serves no routes, firmware
 * touches no database, a project without a package manager declares no
 * dependencies, and an untested project has no test relations. None of those
 * are failures, and reporting them as such would cry wolf on every project
 * that is not a web service.
 */
export const CONDITIONAL_KINDS = [
  "package-dependency",
  "build-target",
  "route",
  "outbound-call",
  "external-call",
  "data-access",
  "auth-annotation",
  "test-relation",
  "validation-rule",
  "transaction-boundary",
  "error-handling",
  "condition",
  "decision",
  "guard",
  "scheduled-task",
  "notification-call",
  "discarded-error",
  // What the project stores. Three readers find these — SQL DDL, ORM
  // migrations, Go structs — and a table declared in two of them is one table
  // that two readers agree on, which is exactly what this model already knows
  // how to represent. Keeping them in a list beside it would have counted that
  // agreement as duplication, with nothing recording that it was agreement.
  "entity",
  "entity-field",
  "entity-relation",
  "entity-constraint",
] as const;

/**
 * Kinds that say something about behaviour a report can name per file.
 *
 * The subset of `CONDITIONAL_KINDS` that answers "does this file tell us
 * anything about what the system does". Used to decide which files a report
 * stopped reading, so membership has one test: would a reader see this fact
 * attributed to this file anywhere?
 *
 * Excluded, and why each:
 *
 * - `error-handling` is reported only as a per-repository count, never per file.
 *   Counting it hid 38 files on one workspace — including a 4.7 KB DTO and an
 *   11 KB mail service — behind an anonymous +1, which is precisely the silence
 *   this list exists to break.
 * - `package-dependency` and `build-target` describe a manifest, not behaviour,
 *   and a manifest is not code a reader opens looking for a missing rule.
 * - `test-relation` says a test covers something, which is a fact about the test
 *   suite rather than about what this file does.
 */
export const NON_BEHAVIOURAL_KINDS = [
  "error-handling",
  "package-dependency",
  "build-target",
  "test-relation",
] as const satisfies readonly ConditionalKind[];

export const BEHAVIOURAL_KINDS = [
  "route",
  "outbound-call",
  "external-call",
  "data-access",
  "auth-annotation",
  "validation-rule",
  "transaction-boundary",
  "condition",
  "decision",
  "guard",
  "scheduled-task",
  "notification-call",
  "discarded-error",
  "entity",
  "entity-field",
  "entity-relation",
  "entity-constraint",
] as const satisfies readonly ConditionalKind[];

/**
 * Proof that every conditional kind was considered, not merely that the
 * behavioural list is a subset.
 *
 * Without this a kind added to `CONDITIONAL_KINDS` lands outside both lists by
 * default, and files carrying only that kind quietly become silent — a new
 * reader's first effect would be to widen a list that exists to be trusted. The
 * union has to be exhaustive, so adding a kind fails the build until someone
 * decides which side it is on.
 */
type Unclassified = Exclude<
  ConditionalKind,
  (typeof BEHAVIOURAL_KINDS)[number] | (typeof NON_BEHAVIOURAL_KINDS)[number]
>;
// A conditional type, not an array: `const x: Unclassified[] = []` compiles for
// every `Unclassified`, because an empty array literal is assignable to any
// element type. That version of this check could never fail, and a guarantee
// stated in a comment and not enforced is worse than none — it tells the next
// person not to look.
type EveryConditionalKindClassified = Unclassified extends never
  ? true
  : ["unclassified conditional kind", Unclassified];
const _everyConditionalKindClassified: EveryConditionalKindClassified = true;
void _everyConditionalKindClassified;

export const STRUCTURAL_KINDS = [...UNIVERSAL_KINDS, ...CONDITIONAL_KINDS] as const;

export type UniversalKind = (typeof UNIVERSAL_KINDS)[number];
export type ConditionalKind = (typeof CONDITIONAL_KINDS)[number];
export type StructuralKind = UniversalKind | ConditionalKind;

/**
 * Records grouped by kind.
 *
 * One bucket per kind rather than a single tagged array: a caller asking for
 * routes should get `RouteRecord[]` without narrowing, and the compile-time
 * checks below guarantee the two lists cannot drift apart.
 */
export interface StructuralRecords {
  readonly "source-file": readonly SourceFileRecord[];
  readonly symbol: readonly SymbolRecord[];
  readonly "call-edge": readonly CallEdgeRecord[];
  readonly import: readonly ImportRecord[];
  readonly export: readonly ExportRecord[];
  readonly reference: readonly ReferenceRecord[];
  readonly "type-relation": readonly TypeRelationRecord[];
  readonly "package-dependency": readonly PackageDependencyRecord[];
  readonly "build-target": readonly BuildTargetRecord[];
  readonly "module-containment": readonly ModuleContainmentRecord[];
  readonly route: readonly RouteRecord[];
  readonly "outbound-call": readonly OutboundCallRecord[];
  readonly "external-call": readonly ExternalCallRecord[];
  readonly "data-access": readonly DataAccessRecord[];
  readonly "auth-annotation": readonly AuthAnnotationRecord[];
  readonly "test-relation": readonly TestRelationRecord[];
  readonly "validation-rule": readonly ValidationRuleRecord[];
  readonly "transaction-boundary": readonly TransactionBoundaryRecord[];
  readonly "error-handling": readonly ErrorHandlingRecord[];
  readonly condition: readonly ConditionRecord[];
  readonly decision: readonly DecisionRecord[];
  readonly guard: readonly GuardRecord[];
  readonly "scheduled-task": readonly ScheduledTaskRecord[];
  readonly "notification-call": readonly NotificationCallRecord[];
  readonly "discarded-error": readonly DiscardedErrorRecord[];
  readonly entity: readonly EntityRecord[];
  readonly "entity-field": readonly FieldRecord[];
  readonly "entity-relation": readonly DataRelationRecord[];
  readonly "entity-constraint": readonly ConstraintRecord[];
}

/**
 * Compile-time proof that the kind list and the record buckets agree, in both
 * directions. Adding a kind without a bucket, or a bucket without a kind,
 * fails to typecheck rather than producing a silently unreachable record type.
 */
type MissingBucket = Exclude<StructuralKind, keyof StructuralRecords>;
type OrphanedBucket = Exclude<keyof StructuralRecords, StructuralKind>;
type _EveryKindHasABucket = MissingBucket extends never ? true : ["missing bucket for", MissingBucket];
type _EveryBucketHasAKind = OrphanedBucket extends never ? true : ["orphaned bucket", OrphanedBucket];
const _kindsMatchBuckets: [_EveryKindHasABucket, _EveryBucketHasAKind] = [true, true];
void _kindsMatchBuckets;

/** An empty bucket for every kind — the starting point for building a contribution. */
export function emptyRecords(): StructuralRecords {
  return {
    "source-file": [],
    symbol: [],
    "call-edge": [],
    import: [],
    export: [],
    reference: [],
    "type-relation": [],
    "package-dependency": [],
    "build-target": [],
    "module-containment": [],
    route: [],
    "outbound-call": [],
    "external-call": [],
    "data-access": [],
    "auth-annotation": [],
    "test-relation": [],
    "validation-rule": [],
    "transaction-boundary": [],
    "error-handling": [],
    condition: [],
    decision: [],
    guard: [],
    "scheduled-task": [],
    "notification-call": [],
    "discarded-error": [],
    entity: [],
    "entity-field": [],
    "entity-relation": [],
    "entity-constraint": [],
  };
}

export function isUniversalKind(kind: StructuralKind): boolean {
  return (UNIVERSAL_KINDS as readonly string[]).includes(kind);
}

/** Total records across every bucket — used for accounting, not for judging quality. */
export function countRecords(records: StructuralRecords): number {
  return STRUCTURAL_KINDS.reduce((total, kind) => total + records[kind].length, 0);
}
