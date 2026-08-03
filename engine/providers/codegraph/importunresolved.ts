/**
 * Import unresolved references and the graph provenance from a batch snapshot
 * (PI-36).
 *
 * An unresolved reference is a fact about the codebase — the graph knows a call
 * or use exists but could not resolve its target — not missing data, so it is
 * imported rather than dropped. Every imported graph fact also carries the
 * graph provenance: which CodeGraph version, schema and index produced it, so an
 * upgrade can never silently change a reported fact.
 */

import type { CodeGraphSnapshot } from "./batch.js";

export interface ImportedUnresolvedRef {
  /** The node the reference is from, as a native id (attribution). */
  readonly fromNativeId: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number | null;
  readonly reason: string;
}

/** The provenance every imported graph fact traces to. */
export interface GraphProvenance {
  readonly provider: "codegraph";
  readonly codegraphVersion: string;
  readonly schemaVersion: string;
  readonly indexRoot: string;
}

export interface UnresolvedImport {
  readonly references: readonly ImportedUnresolvedRef[];
  readonly total: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly provenance: GraphProvenance;
  readonly truncated: boolean;
}

export function graphProvenance(snapshot: CodeGraphSnapshot): GraphProvenance {
  return {
    provider: "codegraph",
    codegraphVersion: snapshot.metadata.codegraphVersion,
    schemaVersion: snapshot.metadata.schemaVersion,
    indexRoot: snapshot.metadata.indexRoot,
  };
}

export function importUnresolved(snapshot: CodeGraphSnapshot): UnresolvedImport {
  const byReason: Record<string, number> = {};
  const references: ImportedUnresolvedRef[] = snapshot.unresolvedReferences.map((ref) => {
    byReason[ref.reason] = (byReason[ref.reason] ?? 0) + 1;
    return {
      fromNativeId: ref.fromNativeId,
      name: ref.name,
      filePath: ref.filePath,
      startLine: ref.startLine,
      reason: ref.reason,
    };
  });

  return {
    references,
    total: references.length,
    byReason,
    provenance: graphProvenance(snapshot),
    truncated: snapshot.truncation.truncated,
  };
}
