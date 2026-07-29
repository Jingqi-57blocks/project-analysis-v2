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

/** Full location. Column included: two facts can share a line. */
function location(source: SourceRef): string {
  return joinKey([source.relPath, source.startLine, source.startColumn]);
}

function position(provenance: Provenance): string {
  return location(provenance.source);
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

  "outbound-call": (r) =>
    joinKey([r.rootName, r.callerSymbolId, r.method, r.target, position(r.provenance)]),
  "external-call": (r) => joinKey([r.rootName, r.callerSymbolId, r.packageName, r.memberName]),
  "data-access": (r) => joinKey([r.rootName, r.symbolId, r.entity, r.operation, position(r.provenance)]),
  // The five kinds below all carry an explicit `source`, and all of them are
  // supplied today by providers that leave `symbolId` null. Their keys must
  // therefore include the full location: without `relPath` the key collapses to
  // the label alone, so every `binding:"..."` tag in a repository would merge
  // into one record, and two files whose `if err != nil {` land on the same line
  // number would merge into one. Nothing downstream could detect that, because a
  // merge records an extra attribution rather than a conflict.
  // The subject, operator and value together are the rule; two rules on one
  // line differ by their text, and the column keeps them apart.
  condition: (r) =>
    joinKey([r.rootName, r.subject, r.operator, String(r.literal), location(r.source)]),
  "discarded-error": (r) => joinKey([r.rootName, r.call, location(r.source)]),
  // The span, not just the start: two decisions can begin on one line, and a
  // decision is identified by the region of code it governs.
  // The column and the branch count as well as the span: two decisions can
  // begin and end on one line, and where neither names a subject the rest of
  // the key is identical — so the second was stored as a duplicate of the
  // first and silently lost.
  decision: (r) =>
    joinKey([
      r.rootName,
      r.source.relPath,
      r.startLine,
      r.endLine,
      r.source.startColumn,
      r.branches.length,
      r.subject,
    ]),
  "auth-annotation": (r) =>
    joinKey([r.rootName, r.symbolId, r.mechanism, r.requirement, location(r.source)]),
  "test-relation": (r) => joinKey([r.rootName, r.testSymbolId, r.targetSymbolId ?? r.targetName]),
  "validation-rule": (r) =>
    joinKey([r.rootName, r.subjectSymbolId, r.field, r.rule, r.expression, location(r.source)]),
  "transaction-boundary": (r) =>
    joinKey([r.rootName, r.symbolId, r.mechanism, location(r.source)]),
  "error-handling": (r) => joinKey([r.rootName, r.symbolId, r.scope, location(r.source)]),

  // Deliberately without a location. Everything above identifies a fact by
  // where it is written; a table is identified by what it is. The SQL
  // migration that creates `leaves`, the ORM migration that alters it and the
  // Go struct that maps it are three declarations of one table, and keying
  // them by file would store three tables and lose the agreement — which is
  // the whole reason the data model was moved into this model.
  // Without the qualifier, which only one of the three readers can supply. A
  // table is one table whether the reader that found it knew its schema, and
  // keying on a field two of them always leave null stored it twice — one row
  // per reader, the duplication this move was meant to end. The qualifier
  // merges as an ordinary field, so a disagreement is retained as a conflict.
  // Two same-named tables in different schemas do share a record; the fields
  // keep their own provenance, so which declaration each came from survives.
  entity: (r) => joinKey([r.rootName, r.name]),
  "entity-field": (r) => joinKey([r.rootName, r.entityName, r.name]),
  // Direction and kind included: `orders.user_id → users.id` as a declared
  // foreign key and as an inferred one are the same relation, but a
  // many-to-many between the same pair is a different one.
  "entity-relation": (r) =>
    joinKey([r.rootName, r.fromEntity, r.fromField, r.toEntity, r.toField, r.kind]),
  // The fields are part of it: one table can carry two unique constraints,
  // and `UNIQUE(a)` is not `UNIQUE(a, b)`.
  "entity-constraint": (r) =>
    joinKey([r.rootName, r.entityName, r.kind, r.fields.join(","), r.expression]),
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
