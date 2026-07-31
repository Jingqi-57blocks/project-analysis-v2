/**
 * Persists and reads back the M2 behaviour model (PI-63).
 *
 * Behaviour facts are shared-fact envelopes; they persist into the same database,
 * inside the same transaction and under the same published_at atomic-publication
 * semantics as every other fact family — not a second store and not a bypass
 * writer. The whole envelope is kept verbatim in `payload`, so an unknown kind or
 * an unresolved provenance survives a round-trip unchanged; the columns beside it
 * are denormalized only for querying (PI-64).
 *
 * The write is transactional and idempotent: re-persisting the same model
 * replaces rather than duplicates, and an interrupted write (a throw, an outer
 * rollback) leaves nothing a later read could mistake for a complete model.
 */

import type { Store } from "../store/types.js";
import type { FactId } from "../contracts/shared-fact/identity.js";
import type {
  BehaviorFact,
  BehaviorModel,
  BehaviorPayload,
  BehaviorRelation,
  BehaviorRelationKind,
} from "../contracts/behavior/schema.js";
import { BEHAVIOR_SCHEMA_VERSION, validateBehaviorModel } from "../contracts/behavior/schema.js";
import { stableStringify } from "../contracts/shared-fact/merge.js";

export interface BehaviorPersistCounts {
  readonly facts: number;
  readonly relations: number;
  readonly diagnostics: number;
  readonly quarantined: number;
}

/**
 * Upper bounds, per snapshot. A snapshot is the shard: a model larger than this
 * is refused whole rather than written in part, so the store degrades to an
 * explicit error, never to a silently truncated graph.
 */
export const MAX_BEHAVIOR_FACTS = 200_000;
export const MAX_BEHAVIOR_RELATIONS = 1_000_000;

export interface BehaviorPersistLimits {
  readonly maxFacts?: number;
  readonly maxRelations?: number;
}

/**
 * Persist a behaviour model for one snapshot. Refuses an invalid model (fail
 * closed — a broken model is never written), refuses one past the resource bound,
 * and otherwise writes facts, relations and quarantine diagnostics in one
 * transaction. A quarantined (unknown-kind) fact is written and flagged, never
 * dropped.
 */
export function persistBehaviorModel(
  store: Store,
  snapshotId: number,
  model: BehaviorModel,
  limits: BehaviorPersistLimits = {},
): BehaviorPersistCounts {
  const maxFacts = limits.maxFacts ?? MAX_BEHAVIOR_FACTS;
  const maxRelations = limits.maxRelations ?? MAX_BEHAVIOR_RELATIONS;

  const validation = validateBehaviorModel(model);
  if (!validation.ok) {
    throw new Error(`refusing to persist an invalid behaviour model: ${validation.reasons.join("; ")}`);
  }
  if (model.facts.length > maxFacts) {
    throw new Error(`behaviour model has ${model.facts.length} facts, over the ${maxFacts} limit`);
  }
  if (model.relations.length > maxRelations) {
    throw new Error(`behaviour model has ${model.relations.length} relations, over the ${maxRelations} limit`);
  }

  const quarantined = new Set<FactId>(validation.quarantined);

  return store.transaction(() => {
    // A snapshot's behaviour model is exactly this model: clear the snapshot's
    // prior behaviour rows first, so re-persisting a smaller model leaves no stale
    // fact behind and re-persisting the same model is an exact replace. All inside
    // the one transaction, so a reader never sees the intermediate empty state.
    store.run("DELETE FROM behavior_facts WHERE snapshot_id = ?", [snapshotId]);
    store.run("DELETE FROM behavior_relations WHERE snapshot_id = ?", [snapshotId]);
    store.run("DELETE FROM behavior_diagnostics WHERE snapshot_id = ?", [snapshotId]);

    for (const fact of model.facts) {
      const payload = fact.payload as Partial<BehaviorPayload>;
      store.run(
        `INSERT OR REPLACE INTO behavior_facts
           (snapshot_id, fact_id, kind, family, scope, activation, schema_version, payload, quarantined)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshotId,
          fact.factId,
          fact.kind,
          fact.family,
          payload.scope ?? null,
          payload.activation ?? null,
          fact.schemaVersion,
          stableStringify(fact),
          quarantined.has(fact.factId) ? 1 : 0,
        ],
      );
    }

    for (const relation of model.relations) {
      store.run(
        `INSERT OR REPLACE INTO behavior_relations (snapshot_id, kind, from_id, to_id, role)
         VALUES (?, ?, ?, ?, ?)`,
        [snapshotId, relation.kind, relation.from, relation.to, relation.role],
      );
    }

    let diagnostics = 0;
    for (const fact of model.facts) {
      if (!quarantined.has(fact.factId)) continue;
      store.run(
        `INSERT OR REPLACE INTO behavior_diagnostics (snapshot_id, fact_id, reason) VALUES (?, ?, ?)`,
        [snapshotId, fact.factId, `quarantined: kind ${fact.kind} is outside the behaviour vocabulary`],
      );
      diagnostics += 1;
    }

    return {
      facts: model.facts.length,
      relations: model.relations.length,
      diagnostics,
      quarantined: quarantined.size,
    };
  });
}

interface RelationRow {
  readonly kind: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly role: string;
}

/**
 * Read a snapshot's behaviour model back, reconstructed from the verbatim
 * envelopes so it equals what was persisted. Order is deterministic (by id), not
 * the original insertion order, so two reads of one snapshot are identical.
 */
export function readBehaviorModel(store: Store, snapshotId: number): BehaviorModel {
  const factRows = store.all<{ payload: string }>(
    "SELECT payload FROM behavior_facts WHERE snapshot_id = ? ORDER BY fact_id",
    [snapshotId],
  );
  const facts = factRows.map((row) => JSON.parse(row.payload) as BehaviorFact);

  const relationRows = store.all<RelationRow>(
    "SELECT kind, from_id, to_id, role FROM behavior_relations WHERE snapshot_id = ? ORDER BY kind, from_id, to_id, role",
    [snapshotId],
  );
  const relations: BehaviorRelation[] = relationRows.map((row) => ({
    kind: row.kind as BehaviorRelationKind,
    from: row.from_id as FactId,
    to: row.to_id as FactId,
    role: row.role,
  }));

  return { schemaVersion: BEHAVIOR_SCHEMA_VERSION, facts, relations };
}

export interface BehaviorDiagnostic {
  readonly factId: string | null;
  readonly reason: string;
}

/** The quarantine and coverage notes recorded for a snapshot, for an audit. */
export function readBehaviorDiagnostics(store: Store, snapshotId: number): readonly BehaviorDiagnostic[] {
  return store
    .all<{ fact_id: string | null; reason: string }>(
      // COALESCE so a future null-fact_id (coverage-gap) diagnostic still sorts
      // to a total order rather than falling to insertion order.
      "SELECT fact_id, reason FROM behavior_diagnostics WHERE snapshot_id = ? ORDER BY COALESCE(fact_id, ''), reason",
      [snapshotId],
    )
    .map((row) => ({ factId: row.fact_id, reason: row.reason }));
}
