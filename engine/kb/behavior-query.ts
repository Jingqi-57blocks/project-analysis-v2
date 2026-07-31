/**
 * Querying the persisted behaviour model (PI-64).
 *
 * The query planner over PI-63's behaviour tables: it selects and traverses
 * behaviour facts by scope, kind, identity, resolution and activation, and it
 * reads only the store — never the source, never a report preset. Every result
 * is in a stable order (by canonical id) so the same query is reproducible, and
 * every bound (a page limit, a traversal cap) is reported rather than silently
 * applied: a truncated result says so and says how much it left out.
 *
 * Kept apart from `query.ts` so the storage, the planner and the export serializer
 * stay separable — the KnowledgeBase does not grow a behaviour subsystem inside it.
 */

import type { Store } from "../store/types.js";
import type { FactId } from "../contracts/shared-fact/identity.js";
import type { ResolutionClass } from "../contracts/shared-fact/provenance.js";
import type {
  BehaviorActivation,
  BehaviorFact,
  BehaviorRelation,
  BehaviorRelationKind,
  BehaviorScope,
} from "../contracts/behavior/schema.js";

export interface BehaviorFactFilter {
  readonly kind?: string;
  readonly scope?: BehaviorScope;
  readonly activation?: BehaviorActivation;
  /** Matches a fact any of whose evidence resolved this way. */
  readonly resolution?: ResolutionClass;
  /** Repository: matches a fact any of whose evidence is in this root. */
  readonly rootName?: string;
  /** File: matches a fact any of whose evidence is in this relative path. */
  readonly relPath?: string;
  /** Identity: a single fact by its canonical id. */
  readonly factId?: FactId;
  /** Include quarantined (unknown-kind) facts. Default true — they are still facts. */
  readonly includeQuarantined?: boolean;
}

export interface Page {
  readonly limit?: number;
  readonly offset?: number;
}

export interface BehaviorFactQueryResult {
  readonly facts: readonly BehaviorFact[];
  /** How many facts matched before pagination. */
  readonly total: number;
  readonly returned: number;
  /** True when the page did not reach the end of the matches. */
  readonly truncated: boolean;
}

function matchesResolution(fact: BehaviorFact, resolution: ResolutionClass): boolean {
  return fact.evidence.some((e) => e.provenance.resolutionClass === resolution);
}

function matchesRoot(fact: BehaviorFact, rootName: string): boolean {
  return fact.evidence.some((e) => e.provenance.source.rootName === rootName);
}

function matchesPath(fact: BehaviorFact, relPath: string): boolean {
  return fact.evidence.some((e) => e.provenance.source.relPath === relPath);
}

/**
 * The facts matching a filter, in a stable order, with the total and a truncation
 * flag so a paged caller knows whether more remain. Column-backed filters (kind,
 * scope, activation, quarantine) are pushed to SQL; the evidence-derived ones
 * (resolution, root, path) are applied to the parsed envelopes.
 */
export function queryBehaviorFacts(
  store: Store,
  snapshotId: number,
  filter: BehaviorFactFilter = {},
  page: Page = {},
): BehaviorFactQueryResult {
  const where: string[] = ["snapshot_id = ?"];
  const params: (string | number)[] = [snapshotId];
  if (filter.kind !== undefined) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.scope !== undefined) {
    where.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.activation !== undefined) {
    where.push("activation = ?");
    params.push(filter.activation);
  }
  if (filter.factId !== undefined) {
    where.push("fact_id = ?");
    params.push(filter.factId);
  }
  if (filter.includeQuarantined === false) {
    where.push("quarantined = 0");
  }

  const rows = store.all<{ payload: string }>(
    `SELECT payload FROM behavior_facts WHERE ${where.join(" AND ")} ORDER BY fact_id`,
    params,
  );

  let facts = rows.map((row) => JSON.parse(row.payload) as BehaviorFact);
  if (filter.resolution !== undefined) facts = facts.filter((f) => matchesResolution(f, filter.resolution!));
  if (filter.rootName !== undefined) facts = facts.filter((f) => matchesRoot(f, filter.rootName!));
  if (filter.relPath !== undefined) facts = facts.filter((f) => matchesPath(f, filter.relPath!));

  const total = facts.length;
  const offset = Math.max(0, page.offset ?? 0);
  const limit = page.limit ?? total - offset;
  const paged = facts.slice(offset, offset + Math.max(0, limit));

  return {
    facts: paged,
    total,
    returned: paged.length,
    truncated: offset + paged.length < total,
  };
}

export interface TraversalLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export interface TraversalResult {
  /** The fact ids reached from the seeds, in stable order, including the seeds. */
  readonly reached: readonly FactId[];
  /**
   * The relations walked. May include an edge whose `to` was cut by `maxNodes`
   * and so is not in `reached` — a dangling edge marks exactly where the bound bit.
   */
  readonly edges: readonly BehaviorRelation[];
  /** True when a limit stopped the traversal before it was exhausted. */
  readonly truncated: boolean;
  /** How many distinct nodes a bound left unreached or unexpanded. */
  readonly affected: number;
}

interface RelationRow {
  readonly kind: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly role: string;
}

/**
 * A bounded forward traversal of the relation graph from a set of seeds. Explores
 * breadth-first in a stable (sorted) order and stops at `maxDepth` or once
 * `maxNodes` are reached; either way it reports `truncated` and how many frontier
 * nodes it did not expand, so a caller never mistakes a capped walk for a complete one.
 */
export function traverseBehaviorRelations(
  store: Store,
  snapshotId: number,
  seeds: readonly FactId[],
  limits: TraversalLimits,
): TraversalResult {
  const reached = new Set<FactId>();
  const edges: BehaviorRelation[] = [];
  // Distinct nodes a bound kept us from fully processing: cut before reaching
  // (maxNodes) or reached but not expanded (maxDepth). A Set so an edge into the
  // same blocked node from two places counts it once.
  const affected = new Set<FactId>();

  let frontier = [...new Set(seeds)].sort();
  for (const seed of frontier) reached.add(seed);

  for (let depth = 0; depth < limits.maxDepth && frontier.length > 0; depth += 1) {
    const next = new Set<FactId>();
    for (const node of frontier) {
      const rows = store.all<RelationRow>(
        "SELECT kind, from_id, to_id, role FROM behavior_relations WHERE snapshot_id = ? AND from_id = ? ORDER BY kind, to_id, role",
        [snapshotId, node],
      );
      for (const row of rows) {
        edges.push({
          kind: row.kind as BehaviorRelationKind,
          from: row.from_id as FactId,
          to: row.to_id as FactId,
          role: row.role,
        });
        const to = row.to_id as FactId;
        if (reached.has(to)) continue;
        if (reached.size >= limits.maxNodes) {
          affected.add(to);
          continue;
        }
        reached.add(to);
        next.add(to);
      }
    }
    frontier = [...next].sort();
  }
  // maxDepth stopped us with a non-empty frontier still to expand.
  for (const node of frontier) affected.add(node);

  return {
    reached: [...reached].sort(),
    edges,
    truncated: affected.size > 0,
    affected: affected.size,
  };
}
