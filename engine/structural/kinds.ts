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
  DiscardedErrorRecord,
  TransactionBoundaryRecord,
  ValidationRuleRecord,
} from "./rules.js";

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
  "discarded-error",
] as const;

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
  readonly "discarded-error": readonly DiscardedErrorRecord[];
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
    "discarded-error": [],
  };
}

export function isUniversalKind(kind: StructuralKind): boolean {
  return (UNIVERSAL_KINDS as readonly string[]).includes(kind);
}

/** Total records across every bucket — used for accounting, not for judging quality. */
export function countRecords(records: StructuralRecords): number {
  return STRUCTURAL_KINDS.reduce((total, kind) => total + records[kind].length, 0);
}
