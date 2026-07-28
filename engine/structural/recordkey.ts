/**
 * Deterministic identity for every record kind.
 *
 * This is what the merge contract runs on. Two providers that independently
 * find the same fact must produce the same key, or the assembler stores two
 * records where the codebase has one and every count downstream is inflated.
 * Conversely, two genuinely different facts must never collide, since a merge
 * cannot be undone by any later stage.
 *
 * Keys are built from the fact's own defining properties — never from a
 * provider's numbering, and never from anything that changes when unrelated
 * code moves. Where a call site's position *is* part of the identity (two
 * calls to the same function from the same caller are different calls), the
 * position is included deliberately and noted below.
 */

import { joinKey } from "./identity.js";
import type { StructuralKind, StructuralRecords } from "./kinds.js";
import type { SourceRef, Provenance } from "./provenance.js";

function position(provenance: Provenance): string {
  const source: SourceRef = provenance.source;
  return joinKey([source.relPath, source.startLine, source.startColumn]);
}

/**
 * Per-kind key builders.
 *
 * Written as an explicit map rather than a switch so that the compiler
 * requires an entry for every kind — a new kind without a key would otherwise
 * silently fall through to a default and collide with everything else of its
 * kind.
 */
const KEY_BUILDERS: {
  readonly [K in StructuralKind]: (record: StructuralRecords[K][number]) => string;
} = {
  "source-file": (r) => joinKey([r.rootName, r.relPath]),

  // The symbol id is already the identity — see identity.ts.
  symbol: (r) => r.id,

  // Position included: two calls to the same callee from one caller are two
  // distinct call sites, and collapsing them would undercount fan-out.
  "call-edge": (r) => joinKey([r.callerId, r.calleeName, position(r.provenance)]),

  import: (r) => joinKey([r.rootName, r.relPath, r.specifier]),
  export: (r) => joinKey([r.rootName, r.relPath, r.name]),

  // A symbol referenced twice in one file is two references.
  reference: (r) => joinKey([r.symbolId, r.kind, r.source.relPath, r.source.startLine, r.source.startColumn]),

  "type-relation": (r) => joinKey([r.subtypeId, r.relation, r.supertypeName]),

  // Scope included: the same package may appear as both a runtime and a test
  // dependency, and those are different declarations with different meaning.
  "package-dependency": (r) => joinKey([r.rootName, r.ecosystem, r.name, r.scope]),

  "build-target": (r) => joinKey([r.rootName, r.name]),
  "module-containment": (r) => joinKey([r.rootName, r.kind, r.containerPath, r.memberPath]),

  // Method and path are the route's identity; two handlers for one method+path
  // is a genuine conflict for the assembler to surface, not two routes.
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

/**
 * The provenance every record carries, for the columns the store denormalizes.
 *
 * Reference records keep their location in `source` rather than only in
 * provenance, so this reads whichever the kind provides.
 */
export function recordProvenance(record: unknown): Provenance {
  return (record as { provenance: Provenance }).provenance;
}
