/**
 * Deterministic identity per record kind — what the merge contract runs on.
 *
 * Two providers finding the same fact must produce the same key, or the
 * assembler stores two records where the codebase has one. Two different facts
 * must never collide, since a merge cannot be undone later.
 */

import { joinKey } from "./identity.js";
import type { StructuralKind, StructuralRecords } from "./kinds.js";
import type { SourceRef, Provenance } from "./provenance.js";

function position(provenance: Provenance): string {
  const source: SourceRef = provenance.source;
  return joinKey([source.relPath, source.startLine, source.startColumn]);
}

/** A map rather than a switch, so the compiler requires an entry for every kind. */
const KEY_BUILDERS: {
  readonly [K in StructuralKind]: (record: StructuralRecords[K][number]) => string;
} = {
  "source-file": (r) => joinKey([r.rootName, r.relPath]),

  symbol: (r) => r.id,

  // Position included: two calls to one callee from one caller are distinct
  // sites, and collapsing them would undercount fan-out.
  "call-edge": (r) => joinKey([r.callerId, r.calleeName, position(r.provenance)]),

  import: (r) => joinKey([r.rootName, r.relPath, r.specifier]),
  export: (r) => joinKey([r.rootName, r.relPath, r.name]),

  reference: (r) => joinKey([r.symbolId, r.kind, r.source.relPath, r.source.startLine, r.source.startColumn]),

  "type-relation": (r) => joinKey([r.subtypeId, r.relation, r.supertypeName]),

  // Scope included: the same package as a runtime and a test dependency is two
  // declarations with different meaning.
  "package-dependency": (r) => joinKey([r.rootName, r.ecosystem, r.name, r.scope]),

  "build-target": (r) => joinKey([r.rootName, r.name]),
  "module-containment": (r) => joinKey([r.rootName, r.kind, r.containerPath, r.memberPath]),

  // Two handlers for one method+path is a conflict to surface, not two routes.
  route: (r) => joinKey([r.rootName, r.method, r.path]),

  "outbound-call": (r) => joinKey([r.rootName, r.callerSymbolId, r.target, position(r.provenance)]),
  "external-call": (r) => joinKey([r.rootName, r.callerSymbolId, r.packageName, r.memberName]),
  "data-access": (r) => joinKey([r.rootName, r.symbolId, r.entity, r.operation, position(r.provenance)]),
  "auth-annotation": (r) =>
    joinKey([r.rootName, r.symbolId, r.mechanism, r.requirement, r.source.startLine]),
  "test-relation": (r) => joinKey([r.rootName, r.testSymbolId, r.targetSymbolId ?? r.targetName]),
  "validation-rule": (r) => joinKey([r.rootName, r.subjectSymbolId, r.field, r.rule]),
  "transaction-boundary": (r) => joinKey([r.rootName, r.symbolId, r.mechanism, r.source.startLine]),
  "error-handling": (r) => joinKey([r.rootName, r.symbolId, r.scope, r.source.startLine]),
};

/** The identity of one record of a given kind. */
export function recordKey<K extends StructuralKind>(
  kind: K,
  record: StructuralRecords[K][number],
): string {
  return KEY_BUILDERS[kind](record);
}

/** The provenance every record carries, for the columns the store denormalizes. */
export function recordProvenance(record: unknown): Provenance {
  return (record as { provenance: Provenance }).provenance;
}
