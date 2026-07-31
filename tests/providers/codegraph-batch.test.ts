import { describe, expect, it } from "vitest";

import {
  checkVersionGate,
  type CodeGraphSnapshot,
  type SnapshotOutcome,
  SUPPORTED_SNAPSHOT_SCHEMA,
  VERIFIED_CODEGRAPH_VERSION,
  versionDiffersFromVerified,
} from "../../engine/providers/codegraph/batch.js";

describe("codegraph batch version gate", () => {
  it("fails closed when codegraph is not installed", () => {
    expect(checkVersionGate(null, SUPPORTED_SNAPSHOT_SCHEMA)?.kind).toBe("version-incompatible");
  });

  it("fails closed on an unsupported schema", () => {
    expect(checkVersionGate(VERIFIED_CODEGRAPH_VERSION, "999")?.kind).toBe("schema-unsupported");
  });

  it("passes on the verified version and supported schema", () => {
    expect(checkVersionGate(VERIFIED_CODEGRAPH_VERSION, SUPPORTED_SNAPSHOT_SCHEMA)).toBeNull();
  });

  it("passes a differing version but flags that it must be recorded", () => {
    expect(checkVersionGate("1.6.0", SUPPORTED_SNAPSHOT_SCHEMA)).toBeNull();
    expect(versionDiffersFromVerified("1.6.0")).toBe(true);
    expect(versionDiffersFromVerified(VERIFIED_CODEGRAPH_VERSION)).toBe(false);
  });
});

describe("batch snapshot contract", () => {
  const snapshot: CodeGraphSnapshot = {
    nodes: [
      { nativeId: "n:1", kind: "symbol", name: "F", filePath: "a.go", startLine: 1, endLine: 2, metadata: {} },
    ],
    edges: [
      { nativeId: "e:1", kind: "call", fromNativeId: "n:1", toNativeId: null, filePath: "a.go", startLine: 1 },
    ],
    unresolvedReferences: [
      { fromNativeId: "n:1", name: "G", filePath: "a.go", startLine: 1, reason: "dynamic dispatch" },
    ],
    metadata: {
      codegraphVersion: VERIFIED_CODEGRAPH_VERSION,
      schemaVersion: SUPPORTED_SNAPSHOT_SCHEMA,
      indexRoot: "/idx",
      rootPrefixes: ["a/"],
      nodeCount: 1,
      edgeCount: 1,
    },
    truncation: { truncated: false, limit: null, reason: null },
  };

  it("enumerates nodes, edges, unresolved refs, metadata and truncation in one read", () => {
    expect(snapshot.nodes.length + snapshot.edges.length + snapshot.unresolvedReferences.length).toBeGreaterThan(0);
    expect(snapshot.metadata.codegraphVersion).toBe(VERIFIED_CODEGRAPH_VERSION);
    expect(snapshot.truncation.truncated).toBe(false);
  });

  it("carries the graph's native id as a raw identity, not a canonical id", () => {
    expect(snapshot.nodes[0]!.nativeId).toBe("n:1");
    expect(snapshot.nodes[0]).not.toHaveProperty("factId");
  });

  it("keeps an unresolved edge's target null with a stated reason", () => {
    expect(snapshot.edges[0]!.toNativeId).toBeNull();
    expect(snapshot.unresolvedReferences[0]!.reason.length).toBeGreaterThan(0);
  });

  it("fails closed to a degradation rather than a partial snapshot", () => {
    const outcome: SnapshotOutcome = {
      ok: false,
      degradation: { kind: "index-incomplete", detail: "only 3 of 5 roots indexed" },
    };
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.degradation.kind).toBe("index-incomplete");
  });
});
