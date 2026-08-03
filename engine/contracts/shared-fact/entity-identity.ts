/**
 * Canonical identity for boundary entities and relation endpoints (PI-60).
 *
 * A data entity (a table) is described by several providers — a SQL migration, an
 * ORM definition, a Go struct — which must converge on one canonical id so their
 * facts merge instead of double-counting. Identity is repository- and
 * schema-scoped: two same-named tables in different schemas are different, and a
 * relation's endpoint is resolved to a canonical entity or left
 * candidate/unresolved rather than attached to an arbitrary same-named one.
 */

import { factId, type FactId } from "./identity.js";

export interface EntityRef {
  readonly repo: string;
  /** The schema/namespace qualifier, or null where the provider has none. */
  readonly schema: string | null;
  readonly name: string;
}

function normalizeEntityName(name: string): string {
  return name.trim();
}

/** Repository- and schema-scoped canonical entity id. */
export function canonicalEntityId(ref: EntityRef): FactId {
  return factId({
    family: "structural",
    kind: "entity",
    discriminators: [ref.repo, ref.schema ?? "", normalizeEntityName(ref.name)],
  });
}

export type EndpointResolution =
  | { readonly kind: "exact"; readonly id: FactId }
  | { readonly kind: "candidate"; readonly ids: readonly FactId[] }
  | { readonly kind: "unresolved"; readonly reason: string };

/**
 * Resolves a relation endpoint named only by an entity name to the canonical
 * entity it refers to. A name matching several entities (the same table name in
 * two schemas) is a candidate set, not an arbitrary pick; a name matching none
 * is unresolved. Never guessed.
 */
export function alignEndpoint(
  name: string,
  entitiesByName: ReadonlyMap<string, readonly FactId[]>,
): EndpointResolution {
  const matches = entitiesByName.get(normalizeEntityName(name)) ?? [];
  if (matches.length === 0) return { kind: "unresolved", reason: `no entity named "${name}"` };
  if (matches.length === 1) return { kind: "exact", id: matches[0]! };
  return { kind: "candidate", ids: [...matches] };
}

export interface RelationEndpoints {
  readonly from: FactId;
  readonly to: FactId;
}

/** The canonical endpoints of a relation between two fully-qualified entities. */
export function canonicalRelation(from: EntityRef, to: EntityRef): RelationEndpoints {
  return { from: canonicalEntityId(from), to: canonicalEntityId(to) };
}

/** Indexes entities by normalized name, for endpoint alignment. */
export function indexEntitiesByName(entities: readonly EntityRef[]): Map<string, FactId[]> {
  const byName = new Map<string, FactId[]>();
  for (const entity of entities) {
    const key = normalizeEntityName(entity.name);
    const list = byName.get(key) ?? [];
    list.push(canonicalEntityId(entity));
    byName.set(key, list);
  }
  return byName;
}
