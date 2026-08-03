import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CodeGraphNodeRecord, CodeGraphSnapshot } from "../../engine/providers/codegraph/batch.js";
import { readBatchDb } from "../../engine/providers/codegraph/batchdb.js";
import { importNodes } from "../../engine/providers/codegraph/importnodes.js";

function snapshotOf(nodes: readonly CodeGraphNodeRecord[]): CodeGraphSnapshot {
  return {
    nodes,
    edges: [],
    unresolvedReferences: [],
    metadata: {
      codegraphVersion: "1.5.0",
      schemaVersion: "8",
      indexRoot: "/idx",
      rootPrefixes: [],
      nodeCount: nodes.length,
      edgeCount: 0,
    },
    truncation: { truncated: false, limit: null, reason: null },
  };
}

describe("importNodes", () => {
  it("classifies structural kinds, keeps the native id, preserves metadata", () => {
    const result = importNodes(
      snapshotOf([
        { nativeId: "file:a.go", kind: "file", name: "a.go", filePath: "a.go", startLine: 1, endLine: 100, metadata: { language: "go" } },
        { nativeId: "sym:F", kind: "function", name: "F", filePath: "a.go", startLine: 10, endLine: 20, metadata: { qualifiedName: "pkg.F", signature: "func F()" } },
        { nativeId: "imp:1", kind: "import", name: "fmt", filePath: "a.go", startLine: 2, endLine: 2, metadata: {} },
        { nativeId: "rt:1", kind: "route", name: "GET /x", filePath: "a.go", startLine: 5, endLine: 5, metadata: {} },
        { nativeId: "w:1", kind: "widget", name: "W", filePath: "a.go", startLine: 30, endLine: 40, metadata: {} },
      ]),
    );
    expect(result.total).toBe(5);
    expect(result.byStructuralKind).toEqual({ "source-file": 1, import: 1, route: 1, symbol: 2 });
    expect(result.byRawKind.function).toBe(1);
    expect(result.unknownKinds).toContain("widget");

    const f = result.nodes.find((n) => n.nativeId === "sym:F")!;
    expect(f.structuralKind).toBe("symbol");
    expect(f.qualifiedName).toBe("pkg.F");
    expect(f.metadata.signature).toBe("func F()");

    // An unknown kind still becomes a symbol (honest label), but it is tracked.
    expect(result.nodes.find((n) => n.nativeId === "w:1")!.structuralKind).toBe("symbol");
  });

  it("reports truncation from the snapshot", () => {
    const base = snapshotOf([]);
    const truncated: CodeGraphSnapshot = { ...base, truncation: { truncated: true, limit: 100, reason: "cap" } };
    expect(importNodes(truncated).truncated).toBe(true);
  });

  it("classifies the real WCP-V2 derived-variant nodes when present", () => {
    const root = ".targets/wcp-v2-wcp-auth-no-manifest";
    const dbPath = `${root}/.codegraph/codegraph.db`;
    if (!existsSync(dbPath)) return; // derived variant absent (e.g. CI) — skip gracefully
    const outcome = readBatchDb(dbPath, root);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = importNodes(outcome.snapshot);
    expect(result.total).toBe(outcome.snapshot.nodes.length);
    const sum = Object.values(result.byStructuralKind).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.total); // every node classified, none dropped
    expect(result.byStructuralKind["source-file"]).toBeGreaterThan(0);
  });
});
