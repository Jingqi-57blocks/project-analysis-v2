import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  CodeGraphEdgeRecord,
  CodeGraphNodeRecord,
  CodeGraphSnapshot,
} from "../../engine/providers/codegraph/batch.js";
import { readBatchDb } from "../../engine/providers/codegraph/batchdb.js";
import { importEdges } from "../../engine/providers/codegraph/importedges.js";

function snapshotOf(
  nodes: readonly CodeGraphNodeRecord[],
  edges: readonly CodeGraphEdgeRecord[],
): CodeGraphSnapshot {
  return {
    nodes,
    edges,
    unresolvedReferences: [],
    metadata: {
      codegraphVersion: "1.5.0",
      schemaVersion: "8",
      indexRoot: "/idx",
      rootPrefixes: [],
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    truncation: { truncated: false, limit: null, reason: null },
  };
}

const node = (id: string): CodeGraphNodeRecord => ({
  nativeId: id,
  kind: "function",
  name: id,
  filePath: "a.go",
  startLine: 1,
  endLine: 2,
  metadata: {},
});

describe("importEdges", () => {
  it("imports every kind, keeps native endpoints, counts resolved/unresolved and dangling", () => {
    const r = importEdges(
      snapshotOf(
        [node("A"), node("B")],
        [
          { nativeId: "1", kind: "calls", fromNativeId: "A", toNativeId: "B", filePath: "a.go", startLine: 1 },
          { nativeId: "2", kind: "references", fromNativeId: "A", toNativeId: null, filePath: "a.go", startLine: 2 },
          { nativeId: "3", kind: "calls", fromNativeId: "A", toNativeId: "Ghost", filePath: "a.go", startLine: 1 },
        ],
      ),
    );
    expect(r.total).toBe(3);
    expect(r.byKind.calls).toBe(2);
    expect(r.byKind.references).toBe(1);
    expect(r.resolvedCount).toBe(2);
    expect(r.unresolvedCount).toBe(1);
    expect(r.danglingEndpoints).toContain("Ghost");
    expect(r.edges.find((e) => e.nativeId === "2")!.toNativeId).toBeNull();
  });

  it("reports truncation from the snapshot", () => {
    const base = snapshotOf([], []);
    expect(importEdges({ ...base, truncation: { truncated: true, limit: 1, reason: "x" } }).truncated).toBe(true);
  });

  it("imports the real WCP-V2 derived-variant edges when present", () => {
    const root = ".targets/wcp-v2-wcp-auth-no-manifest";
    const dbPath = `${root}/.codegraph/codegraph.db`;
    if (!existsSync(dbPath)) return; // derived variant absent (e.g. CI) — skip gracefully
    const outcome = readBatchDb(dbPath, root);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = importEdges(outcome.snapshot);
    expect(r.total).toBe(outcome.snapshot.edges.length);
    // More than just calls — the batch read exposes contains/imports/references.
    expect(r.byKind.calls).toBeGreaterThan(0);
    expect(r.byKind.contains).toBeGreaterThan(0);
    expect(r.resolvedCount + r.unresolvedCount).toBe(r.total);
  });
});
