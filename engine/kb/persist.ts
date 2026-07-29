/**
 * Writes derived facts into the knowledge base, and reads them back.
 *
 * Unlike structural records there is no merge contract here and no
 * attribution: a derived fact has exactly one producer, this pipeline, so two
 * rows with one key would mean the derivation disagreed with itself rather
 * than that two sources agreed. That is a bug, not information — so the write
 * replaces rather than merging, and the count of replacements is returned so a
 * caller can assert it is zero.
 */

import type { Store } from "../store/types.js";
import {
  DERIVED_KINDS,
  derivedKey,
  type DerivedKind,
  type DerivedLink,
  type DerivedRecords,
} from "./kinds.js";
import type { CoverageNote, FeatureFindingFact, ModuleFact, FeatureFact } from "./facts.js";
import type { BusinessRule } from "../semantics/rules.js";
import type { ValueSet } from "../semantics/enums.js";

export interface DerivedCounts {
  readonly inserted: number;
  /** Rows whose key already existed. Non-zero means two facts collided. */
  readonly replaced: number;
  readonly links: number;
}

/**
 * The columns lifted out of the payload, per kind.
 *
 * Only what gets filtered on: what a fact is about, where it lives, and how
 * much it matters. Anything else stays in the payload, because a column that
 * exists to avoid one JSON parse is a column that has to be kept true.
 */
interface Indexed {
  readonly subjectKey: string | null;
  readonly rootName: string | null;
  readonly severity: string | null;
  readonly relPath: string | null;
  readonly startLine: number | null;
}

const NONE: Indexed = {
  subjectKey: null,
  rootName: null,
  severity: null,
  relPath: null,
  startLine: null,
};

function located(rootName: string, relPath: string, startLine: number | null): Indexed {
  return { ...NONE, rootName, relPath, startLine };
}

function indexOf(kind: DerivedKind, record: unknown): Indexed {
  switch (kind) {
    case "feature": {
      const feature = record as FeatureFact;
      return { ...NONE, subjectKey: feature.id, rootName: feature.rootNames[0] ?? null };
    }
    case "feature-flow": {
      const flow = record as DerivedRecords["feature-flow"][number];
      return { ...NONE, subjectKey: flow.featureId };
    }
    case "feature-finding": {
      const finding = record as FeatureFindingFact;
      return { ...NONE, subjectKey: finding.featureId, severity: finding.severity };
    }
    case "business-rule": {
      const rule = record as BusinessRule;
      return located(rule.rootName, rule.relPath, rule.startLine);
    }
    case "value-set": {
      const set = record as ValueSet;
      return { ...located(set.rootName, set.relPath, set.startLine), subjectKey: set.name };
    }
    case "module": {
      const module = record as ModuleFact;
      return { ...NONE, subjectKey: module.id, rootName: module.rootNames[0] ?? null };
    }
    case "component": {
      const component = record as DerivedRecords["component"][number];
      return { ...NONE, subjectKey: component.id, rootName: component.rootName };
    }
    case "trace": {
      const trace = record as DerivedRecords["trace"][number];
      return { ...NONE, subjectKey: trace.entryKey, rootName: trace.entryRoot };
    }
    case "cross-root-link":
    case "unlinked-call": {
      const linked = record as { rootName?: string; fromRoot: string; provenance: { source: { relPath: string; startLine: number | null } } };
      return located(linked.fromRoot, linked.provenance.source.relPath, linked.provenance.source.startLine);
    }
    case "base-binding": {
      const binding = record as DerivedRecords["base-binding"][number];
      return { ...NONE, subjectKey: binding.baseIdentifier, rootName: binding.fromRoot };
    }
    case "structural-finding":
    case "health-signal": {
      const finding = record as { id: string; severity: string };
      return { ...NONE, subjectKey: finding.id, severity: finding.severity };
    }
    case "coverage-note": {
      const note = record as CoverageNote;
      return { ...NONE, subjectKey: note.subject };
    }
    case "map-edge": {
      const edge = record as DerivedRecords["map-edge"][number];
      return { ...NONE, subjectKey: edge.from, rootName: edge.from };
    }
    case "run-context":
      return NONE;
  }
}

/**
 * Persists every derived fact for one snapshot, and the links between them.
 *
 * One transaction for the whole set. A knowledge base holding this run's
 * features but the previous run's flows would be worse than one holding
 * neither: a reader cannot see that the halves disagree, and every claim built
 * on the join would be wrong in a way nothing detects.
 */
export function recordDerived(
  store: Store,
  snapshotId: number,
  records: DerivedRecords,
  links: readonly DerivedLink[] = [],
): DerivedCounts {
  return store.transaction(() => {
    let inserted = 0;
    let replaced = 0;

    for (const kind of DERIVED_KINDS) {
      for (const record of records[kind] as readonly unknown[]) {
        const key = derivedKey(kind, record as never);
        const index = indexOf(kind, record);

        const existing = store.get<{ id: number }>(
          "SELECT id FROM derived_records WHERE snapshot_id = ? AND kind = ? AND record_key = ?",
          [snapshotId, kind, key],
        );
        if (existing) replaced += 1;
        else inserted += 1;

        store.run(
          `INSERT OR REPLACE INTO derived_records
             (snapshot_id, kind, record_key, payload, subject_key, root_name, severity, rel_path, start_line)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshotId,
            kind,
            key,
            JSON.stringify(record),
            index.subjectKey,
            index.rootName,
            index.severity,
            index.relPath,
            index.startLine,
          ],
        );
      }
    }

    for (const link of links) {
      store.run(
        `INSERT OR IGNORE INTO derived_links
           (snapshot_id, from_kind, from_key, role, to_kind, to_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [snapshotId, link.fromKind, link.fromKey, link.role, link.toKind, link.toKey],
      );
    }

    return { inserted, replaced, links: links.length };
  });
}

export interface StoredDerived<K extends DerivedKind = DerivedKind> {
  readonly kind: K;
  readonly key: string;
  readonly record: DerivedRecords[K][number];
}

/** Every record of one kind, in insertion order. */
export function readDerived<K extends DerivedKind>(
  store: Store,
  snapshotId: number,
  kind: K,
): readonly StoredDerived<K>[] {
  return store
    .all<{ record_key: string; payload: string }>(
      "SELECT record_key, payload FROM derived_records WHERE snapshot_id = ? AND kind = ? ORDER BY id",
      [snapshotId, kind],
    )
    .map((row) => ({
      kind,
      key: row.record_key,
      record: JSON.parse(row.payload) as DerivedRecords[K][number],
    }));
}

/** Records of one kind about one subject — a feature's flows, a module's findings. */
export function readDerivedFor<K extends DerivedKind>(
  store: Store,
  snapshotId: number,
  kind: K,
  subjectKey: string,
): readonly DerivedRecords[K][number][] {
  return store
    .all<{ payload: string }>(
      `SELECT payload FROM derived_records
       WHERE snapshot_id = ? AND kind = ? AND subject_key = ? ORDER BY id`,
      [snapshotId, kind, subjectKey],
    )
    .map((row) => JSON.parse(row.payload) as DerivedRecords[K][number]);
}

/** The one record of a singleton kind, or null where the run stored none. */
export function readDerivedOne<K extends DerivedKind>(
  store: Store,
  snapshotId: number,
  kind: K,
): DerivedRecords[K][number] | null {
  const row = store.get<{ payload: string }>(
    "SELECT payload FROM derived_records WHERE snapshot_id = ? AND kind = ? ORDER BY id LIMIT 1",
    [snapshotId, kind],
  );
  return row ? (JSON.parse(row.payload) as DerivedRecords[K][number]) : null;
}

/** What a fact points at in a given role. */
export function readLinks(
  store: Store,
  snapshotId: number,
  fromKind: DerivedKind,
  fromKey: string,
  role?: string,
): readonly DerivedLink[] {
  const sql =
    role === undefined
      ? `SELECT from_kind, from_key, role, to_kind, to_key FROM derived_links
         WHERE snapshot_id = ? AND from_kind = ? AND from_key = ? ORDER BY role, to_key`
      : `SELECT from_kind, from_key, role, to_kind, to_key FROM derived_links
         WHERE snapshot_id = ? AND from_kind = ? AND from_key = ? AND role = ? ORDER BY to_key`;
  const params =
    role === undefined ? [snapshotId, fromKind, fromKey] : [snapshotId, fromKind, fromKey, role];

  return store
    .all<{ from_kind: string; from_key: string; role: string; to_kind: string; to_key: string }>(
      sql,
      params,
    )
    .map((row) => ({
      fromKind: row.from_kind as DerivedKind,
      fromKey: row.from_key,
      role: row.role,
      toKind: row.to_kind,
      toKey: row.to_key,
    }));
}

/** What points at a fact — the reverse direction, for "which feature owns this". */
export function readLinksTo(
  store: Store,
  snapshotId: number,
  toKind: string,
  toKey: string,
  role?: string,
): readonly DerivedLink[] {
  const clause = role === undefined ? "" : " AND role = ?";
  const params = role === undefined ? [snapshotId, toKind, toKey] : [snapshotId, toKind, toKey, role];

  return store
    .all<{ from_kind: string; from_key: string; role: string; to_kind: string; to_key: string }>(
      `SELECT from_kind, from_key, role, to_kind, to_key FROM derived_links
       WHERE snapshot_id = ? AND to_kind = ? AND to_key = ?${clause} ORDER BY from_key`,
      params,
    )
    .map((row) => ({
      fromKind: row.from_kind as DerivedKind,
      fromKey: row.from_key,
      role: row.role,
      toKind: row.to_kind,
      toKey: row.to_key,
    }));
}

/** How many records of each kind a snapshot holds — for status and accounting. */
export function derivedCountsByKind(
  store: Store,
  snapshotId: number,
): ReadonlyMap<DerivedKind, number> {
  const counts = new Map<DerivedKind, number>();
  for (const row of store.all<{ kind: string; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM derived_records WHERE snapshot_id = ? GROUP BY kind",
    [snapshotId],
  )) {
    counts.set(row.kind as DerivedKind, row.n);
  }
  return counts;
}
