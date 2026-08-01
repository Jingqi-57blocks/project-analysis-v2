import { describe, expect, it } from "vitest";

import type {
  CodeGraphEdgeRecord,
  CodeGraphNodeRecord,
  CodeGraphSnapshot,
} from "../../engine/providers/codegraph/batch.js";
import { lineRef } from "../../engine/structural/provenance.js";
import type { NotificationCallRecord } from "../../engine/structural/rules.js";
import {
  deriveNotificationReachability,
  rootRelativePrefix,
  scopeSnapshotToRoot,
} from "../../engine/kb/notification-reachability.js";

const ROOT = "svc";

function node(
  nativeId: string,
  kind: string,
  filePath: string,
  startLine: number,
  endLine: number,
  name = nativeId,
): CodeGraphNodeRecord {
  return { nativeId, kind, name, filePath, startLine, endLine, metadata: {} };
}

function callsEdge(nativeId: string, from: string, to: string, filePath: string): CodeGraphEdgeRecord {
  return { nativeId, kind: "calls", fromNativeId: from, toNativeId: to, filePath, startLine: 1 };
}

function snapshotOf(
  nodes: readonly CodeGraphNodeRecord[],
  edges: readonly CodeGraphEdgeRecord[] = [],
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

function sink(relPath: string, startLine: number, mechanism = "messaging().send", channel = "push"): NotificationCallRecord {
  const source = lineRef(ROOT, relPath, startLine);
  return { rootName: ROOT, channel, mechanism, source, provenance: { resolutionClass: "inferred", source, confidence: "low" } };
}

const at = (n: NotificationCallRecord) => ({
  relPath: n.source.relPath,
  startLine: n.source.startLine,
  mechanism: n.mechanism,
  channel: n.channel,
});

describe("deriveNotificationReachability — reverse-reaching a send sink to its handler", () => {
  it("attributes both the sink's own function and the handler that reaches it", () => {
    // handler h.go:1-10 → helper h.go:12-20, and the send sink sits at h.go:15.
    const snapshot = snapshotOf(
      [node("helper", "function", "h.go", 12, 20), node("handler", "function", "h.go", 1, 10)],
      [callsEdge("e1", "handler", "helper", "h.go")],
    );
    const result = deriveNotificationReachability({ rootName: ROOT, sinks: [sink("h.go", 15)], snapshot });

    // Sorted by (relPath, startLine, mechanism): handler (line 1) before helper (line 12).
    expect(result.notifications.map(at)).toEqual([
      { relPath: "h.go", startLine: 1, mechanism: "reaches:messaging().send", channel: "push" },
      { relPath: "h.go", startLine: 12, mechanism: "messaging().send", channel: "push" },
    ]);
    // Every attributed record is a low-confidence inference.
    for (const n of result.notifications) {
      expect(n.provenance).toMatchObject({ resolutionClass: "inferred", confidence: "low" });
      expect(n.rootName).toBe(ROOT);
    }
  });

  it("is deterministic regardless of node/edge input order", () => {
    const nodes = [node("handler", "function", "h.go", 1, 10), node("helper", "method", "h.go", 12, 20)];
    const edges = [callsEdge("e1", "handler", "helper", "h.go")];
    const forward = deriveNotificationReachability({ rootName: ROOT, sinks: [sink("h.go", 15)], snapshot: snapshotOf(nodes, edges) });
    const reversed = deriveNotificationReachability({
      rootName: ROOT,
      sinks: [sink("h.go", 15)],
      snapshot: snapshotOf([...nodes].reverse(), [...edges].reverse()),
    });
    expect(reversed.notifications).toEqual(forward.notifications);
  });

  it("stops at maxHops — a caller six hops away is not attributed", () => {
    // f1→f0 (sink), f2→f1, … f6→f5. f0 is the sink's function; f6 is six hops back.
    const nodes = [node("f0", "function", "chain.go", 100, 110)];
    const edges: CodeGraphEdgeRecord[] = [];
    for (let i = 1; i <= 6; i++) {
      nodes.push(node(`f${i}`, "function", "chain.go", i * 10, i * 10 + 9));
      edges.push(callsEdge(`e${i}`, `f${i}`, `f${i - 1}`, "chain.go"));
    }
    const result = deriveNotificationReachability({
      rootName: ROOT,
      sinks: [sink("chain.go", 105)],
      snapshot: snapshotOf(nodes, edges),
      maxHops: 4,
    });

    const lines = result.notifications.map((n) => n.source.startLine);
    expect(lines).toContain(100); // f0, the sink function (depth 0)
    expect(lines).toContain(40); // f4, four hops back
    expect(lines).not.toContain(50); // f5, five hops back
    expect(lines).not.toContain(60); // f6, six hops back
    expect(result.notes.some((note) => note.includes("capped at maxHops 4"))).toBe(true);
  });

  it("does not expand through a hub whose fan-in exceeds maxFanIn", () => {
    // f0 (sink) ← H, and H is called by a, b, c (fan-in 3). With maxFanIn 2, H is
    // attributed but never expanded, so a/b/c are not.
    const snapshot = snapshotOf(
      [
        node("f0", "function", "hub.go", 1, 9),
        node("H", "function", "hub.go", 10, 19),
        node("a", "function", "hub.go", 20, 29),
        node("b", "function", "hub.go", 30, 39),
        node("c", "function", "hub.go", 40, 49),
      ],
      [
        callsEdge("e0", "H", "f0", "hub.go"),
        callsEdge("ea", "a", "H", "hub.go"),
        callsEdge("eb", "b", "H", "hub.go"),
        callsEdge("ec", "c", "H", "hub.go"),
      ],
    );
    const result = deriveNotificationReachability({
      rootName: ROOT,
      sinks: [sink("hub.go", 5)],
      snapshot,
      maxFanIn: 2,
    });

    const lines = result.notifications.map((n) => n.source.startLine).sort((x, y) => (x ?? 0) - (y ?? 0));
    expect(lines).toEqual([1, 10]); // f0 and H only
    expect(result.notes.some((note) => note.includes("fan-in 3 > maxFanIn 2"))).toBe(true);
  });

  it("attributes only the sink's function when nothing reverse-reaches it (the WCP shape)", () => {
    // A leaf send with no inbound calls edge — the goroutine/interface/channel
    // break in WCP severs exactly this. Only the sink's own function is attributed.
    const snapshot = snapshotOf([node("leaf", "function", "leaf.go", 1, 10)]);
    const result = deriveNotificationReachability({ rootName: ROOT, sinks: [sink("leaf.go", 5)], snapshot });

    expect(result.notifications).toHaveLength(1);
    expect(at(result.notifications[0]!)).toEqual({ relPath: "leaf.go", startLine: 1, mechanism: "messaging().send", channel: "push" });
  });

  it("maps the sink to the innermost enclosing callable, not an outer one that spans it", () => {
    // outer 1-30 spans inner 10-20; the sink at line 15 belongs to inner.
    const snapshot = snapshotOf(
      [node("outer", "function", "n.go", 1, 30), node("inner", "method", "n.go", 10, 20)],
      [callsEdge("e1", "outer", "inner", "n.go")],
    );
    const result = deriveNotificationReachability({ rootName: ROOT, sinks: [sink("n.go", 15)], snapshot });

    // The depth-0 (own-mechanism) record sits at inner's start line, not outer's.
    const own = result.notifications.find((n) => n.mechanism === "messaging().send")!;
    expect(own.source.startLine).toBe(10);
    const reaches = result.notifications.find((n) => n.mechanism === "reaches:messaging().send")!;
    expect(reaches.source.startLine).toBe(1); // outer reaches it
  });

  it("discloses a sink that sits in no indexed callable rather than dropping it silently", () => {
    const snapshot = snapshotOf([node("other", "function", "x.go", 1, 5)]);
    const result = deriveNotificationReachability({ rootName: ROOT, sinks: [sink("x.go", 50)], snapshot });
    expect(result.notifications).toHaveLength(0);
    expect(result.notes.some((note) => note.includes("sits in no indexed callable"))).toBe(true);
  });
});

describe("scopeSnapshotToRoot — root-relative paths for a shared index", () => {
  it("strips the per-root prefix and drops sibling roots", () => {
    const snapshot = snapshotOf(
      [
        node("n1", "function", "angels-pizza/admin-backend/src/order.js", 1, 10),
        node("n2", "function", "other-root/x.js", 1, 10),
      ],
      [
        callsEdge("e1", "n1", "n1", "angels-pizza/admin-backend/src/order.js"),
        callsEdge("e2", "n2", "n2", "other-root/x.js"),
      ],
    );
    const scoped = scopeSnapshotToRoot(snapshot, "/idx", "/idx/angels-pizza");

    expect(scoped.nodes.map((n) => n.filePath)).toEqual(["admin-backend/src/order.js"]);
    expect(scoped.edges.map((e) => e.filePath)).toEqual(["admin-backend/src/order.js"]);
    expect(scoped.metadata.nodeCount).toBe(1);
  });

  it("leaves paths untouched when the index root is the root itself", () => {
    expect(rootRelativePrefix("/idx/svc", "/idx/svc")).toBe("");
    const snapshot = snapshotOf([node("n1", "function", "src/order.js", 1, 10)]);
    expect(scopeSnapshotToRoot(snapshot, "/idx/svc", "/idx/svc")).toBe(snapshot);
  });
});
