import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CodeGraphSnapshot, UnresolvedReference } from "../../engine/providers/codegraph/batch.js";
import { readBatchDb } from "../../engine/providers/codegraph/batchdb.js";
import { graphProvenance, importUnresolved } from "../../engine/providers/codegraph/importunresolved.js";

function snapshotOf(refs: readonly UnresolvedReference[]): CodeGraphSnapshot {
  return {
    nodes: [],
    edges: [],
    unresolvedReferences: refs,
    metadata: {
      codegraphVersion: "1.5.0",
      schemaVersion: "8",
      indexRoot: "/idx",
      rootPrefixes: [],
      nodeCount: 0,
      edgeCount: 0,
    },
    truncation: { truncated: false, limit: null, reason: null },
  };
}

describe("importUnresolved", () => {
  it("imports unresolved refs, counts by reason, and carries graph provenance", () => {
    const result = importUnresolved(
      snapshotOf([
        { fromNativeId: "A", name: "bytes", filePath: "a.go", startLine: 7, reason: "imports: failed" },
        { fromNativeId: "A", name: "json", filePath: "a.go", startLine: 8, reason: "imports: failed" },
        { fromNativeId: "B", name: "Reflect", filePath: "b.go", startLine: 3, reason: "calls: dynamic" },
      ]),
    );
    expect(result.total).toBe(3);
    expect(result.byReason["imports: failed"]).toBe(2);
    expect(result.byReason["calls: dynamic"]).toBe(1);
    expect(result.references[0]!.fromNativeId).toBe("A");
    // An upgrade is never silent: the provenance records the version + schema.
    expect(result.provenance).toEqual({
      provider: "codegraph",
      codegraphVersion: "1.5.0",
      schemaVersion: "8",
      indexRoot: "/idx",
    });
  });

  it("derives graph provenance directly from snapshot metadata", () => {
    const p = graphProvenance(snapshotOf([]));
    expect(p.provider).toBe("codegraph");
    expect(p.codegraphVersion).toBe("1.5.0");
  });

  it("imports the real WCP-V2 derived-variant unresolved refs when present", () => {
    const root = ".targets/wcp-v2-wcp-auth-no-manifest";
    const dbPath = `${root}/.codegraph/codegraph.db`;
    if (!existsSync(dbPath)) return; // derived variant absent (e.g. CI) — skip gracefully
    const outcome = readBatchDb(dbPath, root);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = importUnresolved(outcome.snapshot);
    expect(result.total).toBe(outcome.snapshot.unresolvedReferences.length);
    expect(result.total).toBeGreaterThan(0);
    expect(result.provenance.codegraphVersion).toBe("1.5.0");
  });
});
