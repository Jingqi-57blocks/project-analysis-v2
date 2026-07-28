import type { Store } from "../store/types.js";
import type { Provenance } from "../structural/provenance.js";
import type { SymbolId } from "../structural/identity.js";
import type { AssembledEvidenceSet } from "./assemble.js";
import type { EvidenceItem } from "./types.js";

export interface EvidenceCounts {
  readonly inserted: number;
  readonly merged: number;
  readonly conflicts: number;
  readonly gaps: number;
}

function confidenceOf(provenance: Provenance): string | null {
  return "confidence" in provenance ? provenance.confidence : null;
}

export function recordEvidence(
  store: Store,
  snapshotId: number,
  sourceRootId: number,
  evidence: AssembledEvidenceSet,
): EvidenceCounts {
  return store.transaction(() => {
    let inserted = 0;
    let merged = 0;
    let conflicts = 0;

    for (const assembled of evidence.items) {
      const item = assembled.item;
      const existing = store.get<{ id: number }>(
        "SELECT id FROM evidence_items WHERE snapshot_id = ? AND item_key = ?",
        [snapshotId, assembled.key],
      );

      let itemId: number;
      if (existing) {
        itemId = existing.id;
        merged += 1;
      } else {
        store.run(
          `INSERT INTO evidence_items
             (snapshot_id, source_root_id, kind, item_key, text, label, symbol_id,
              rel_path, start_line, start_column, resolution_class, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshotId,
            sourceRootId,
            item.kind,
            assembled.key,
            item.text,
            item.label,
            item.symbolId,
            item.source.relPath,
            item.source.startLine,
            item.source.startColumn,
            item.provenance.resolutionClass,
            confidenceOf(item.provenance),
          ],
        );
        const row = store.get<{ id: number }>(
          "SELECT id FROM evidence_items WHERE snapshot_id = ? AND item_key = ?",
          [snapshotId, assembled.key],
        );
        if (!row) throw new Error(`Failed to read back the evidence item just inserted: ${item.kind}`);
        itemId = row.id;
        inserted += 1;
      }

      for (const attribution of assembled.attributions) {
        store.run(
          `INSERT OR IGNORE INTO evidence_attributions (item_id, collector_id, collector_version)
           VALUES (?, ?, ?)`,
          [itemId, attribution.collectorId, attribution.collectorVersion],
        );
      }

      for (const conflict of assembled.conflictingText) {
        store.run(
          "INSERT OR REPLACE INTO evidence_conflicts (item_id, collector_id, text) VALUES (?, ?, ?)",
          [itemId, conflict.collectorId, conflict.text],
        );
        conflicts += 1;
      }
    }

    for (const gap of evidence.gaps) {
      store.run(
        `INSERT INTO evidence_gaps (snapshot_id, source_root_id, collector_id, kind, language, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [snapshotId, sourceRootId, gap.collectorId, gap.kind, gap.language, gap.reason],
      );
    }

    return { inserted, merged, conflicts, gaps: evidence.gaps.length };
  });
}

export interface StoredEvidence {
  readonly kind: string;
  readonly text: string;
  readonly label: string | null;
  readonly symbolId: SymbolId | null;
  readonly relPath: string;
  readonly startLine: number | null;
  readonly attributions: readonly string[];
}

export function readEvidence(
  store: Store,
  snapshotId: number,
  kind?: string,
): readonly StoredEvidence[] {
  const rows = kind
    ? store.all<{
        id: number; kind: string; text: string; label: string | null;
        symbol_id: string | null; rel_path: string; start_line: number | null;
      }>(
        `SELECT id, kind, text, label, symbol_id, rel_path, start_line FROM evidence_items
         WHERE snapshot_id = ? AND kind = ? ORDER BY id`,
        [snapshotId, kind],
      )
    : store.all<{
        id: number; kind: string; text: string; label: string | null;
        symbol_id: string | null; rel_path: string; start_line: number | null;
      }>(
        "SELECT id, kind, text, label, symbol_id, rel_path, start_line FROM evidence_items WHERE snapshot_id = ? ORDER BY id",
        [snapshotId],
      );

  return rows.map((row) => ({
    kind: row.kind,
    text: row.text,
    label: row.label,
    symbolId: row.symbol_id as SymbolId | null,
    relPath: row.rel_path,
    startLine: row.start_line,
    attributions: store
      .all<{ collector_id: string }>(
        "SELECT collector_id FROM evidence_attributions WHERE item_id = ? ORDER BY collector_id",
        [row.id],
      )
      .map((a) => a.collector_id),
  }));
}

/** Evidence whose text two collectors disagreed about. */
export function readEvidenceConflicts(
  store: Store,
  snapshotId: number,
): readonly { readonly itemKey: string; readonly collectorId: string; readonly text: string }[] {
  return store
    .all<{ item_key: string; collector_id: string; text: string }>(
      `SELECT i.item_key, c.collector_id, c.text FROM evidence_conflicts c
       JOIN evidence_items i ON i.id = c.item_id
       WHERE i.snapshot_id = ? ORDER BY i.item_key`,
      [snapshotId],
    )
    .map((row) => ({ itemKey: row.item_key, collectorId: row.collector_id, text: row.text }));
}

export type { EvidenceItem };
