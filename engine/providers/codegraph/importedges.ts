/**
 * Import all resolved CodeGraph relations from a batch snapshot (PI-35).
 *
 * Maps the snapshot's edges into an intermediate import that keeps every edge
 * kind (calls/contains/implements/imports/instantiates/references, not just
 * calls) with both endpoints as CodeGraph native ids — attribution, never
 * canonical ids, which PI-7 reconciles later. An edge whose target the graph
 * could not resolve keeps a null target rather than being dropped, so the fact
 * that a relation exists survives even when its far end does not. Per-kind and
 * resolved/unresolved counts are reported so a real index's relation set is
 * checkable.
 */

import type { CodeGraphSnapshot } from "./batch.js";

export interface ImportedEdge {
  /** CodeGraph's own edge id, kept as attribution. */
  readonly nativeId: string;
  readonly kind: string;
  readonly fromNativeId: string;
  /** Null when the graph could not resolve the far end. */
  readonly toNativeId: string | null;
  readonly filePath: string;
  readonly startLine: number | null;
}

export interface EdgeImport {
  readonly edges: readonly ImportedEdge[];
  readonly total: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly resolvedCount: number;
  /** Edges whose far end the graph left null — a relation without a resolved target. */
  readonly unresolvedCount: number;
  /** Endpoints that do not correspond to any imported node id (dangling). */
  readonly danglingEndpoints: readonly string[];
  readonly truncated: boolean;
}

export function importEdges(snapshot: CodeGraphSnapshot): EdgeImport {
  const nodeIds = new Set(snapshot.nodes.map((n) => n.nativeId));
  const byKind: Record<string, number> = {};
  const dangling = new Set<string>();
  let resolved = 0;
  let unresolved = 0;

  const edges: ImportedEdge[] = snapshot.edges.map((edge) => {
    byKind[edge.kind] = (byKind[edge.kind] ?? 0) + 1;
    if (edge.toNativeId === null) unresolved += 1;
    else resolved += 1;
    // A resolved endpoint that names no imported node is dangling — recorded,
    // not silently accepted, since a canonical reconciliation would otherwise
    // resolve it to nothing without explanation.
    if (!nodeIds.has(edge.fromNativeId)) dangling.add(edge.fromNativeId);
    if (edge.toNativeId !== null && !nodeIds.has(edge.toNativeId)) dangling.add(edge.toNativeId);
    return {
      nativeId: edge.nativeId,
      kind: edge.kind,
      fromNativeId: edge.fromNativeId,
      toNativeId: edge.toNativeId,
      filePath: edge.filePath,
      startLine: edge.startLine,
    };
  });

  return {
    edges,
    total: edges.length,
    byKind,
    resolvedCount: resolved,
    unresolvedCount: unresolved,
    danglingEndpoints: [...dangling].sort(),
    truncated: snapshot.truncation.truncated,
  };
}
