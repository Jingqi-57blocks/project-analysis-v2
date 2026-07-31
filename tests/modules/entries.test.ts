import { describe, expect, it } from "vitest";

import { buildEntryTraces, identifyEntries, type EntryInput } from "../../engine/modules/entries.js";
import { symbolId } from "../../engine/structural/identity.js";
import { declared, inferred, lineRef } from "../../engine/structural/provenance.js";
import type { CallEdgeRecord, SymbolRecord, Visibility } from "../../engine/structural/code.js";
import type { RouteRecord } from "../../engine/structural/boundaries.js";

function sym(name: string, visibility: Visibility = "unknown", relPath = "a.go"): SymbolRecord {
  return {
    id: symbolId({ rootName: "svc", relPath, kind: "function", qualifiedName: name, signature: null }),
    name,
    qualifiedName: name,
    kind: "function",
    visibility,
    signature: null,
    containerId: null,
    provenance: declared(lineRef("svc", relPath, 1, 50)),
  };
}

function edge(from: SymbolRecord, to: SymbolRecord | null, name?: string): CallEdgeRecord {
  return {
    callerId: from.id,
    calleeId: to?.id ?? null,
    calleeName: to?.name ?? name ?? "unknown",
    provenance: declared(lineRef("svc", "a.go", 5)),
  };
}

function route(path: string, handler: SymbolRecord | null): RouteRecord {
  return {
    rootName: "svc",
    method: "GET",
    path,
    surface: "server",
    handlerSymbolId: handler?.id ?? null,
    handlerName: handler?.name ?? null,
    handlerCandidates: [],
    middleware: [],
    provenance: inferred(lineRef("svc", "routes.go", 3), "low"),
  };
}

describe("identifyEntries", () => {
  it("classifies precise, candidate and structure-root, disjointly", () => {
    const handler = sym("HandleOrders", "public");
    const exported = sym("ExportedHelper", "public");
    const root = sym("privateRoot", "private");
    const called = sym("privateCalled", "private");
    const input: EntryInput = {
      routes: [route("/orders", handler)],
      symbols: [handler, exported, root, called],
      callEdges: [edge(root, called)],
    };
    const entries = identifyEntries(input);
    const byId = new Map(entries.map((e) => [e.symbolId, e]));
    expect(byId.get(handler.id)!.entryClass).toBe("precise");
    expect(byId.get(exported.id)!.entryClass).toBe("candidate");
    expect(byId.get(root.id)!.entryClass).toBe("structure-root");
    // a symbol that is called by something in the graph is not an entry
    expect(byId.has(called.id)).toBe(false);
    // disjoint: each symbol appears once
    expect(entries.length).toBe(new Set(entries.map((e) => e.symbolId)).size);
  });

  it("still yields entries with no route reader — the generic path works", () => {
    const exported = sym("PublicApi", "public");
    const root = sym("main", "private");
    const entries = identifyEntries({ routes: [], symbols: [exported, root], callEdges: [] });
    expect(entries.map((e) => e.entryClass).sort()).toEqual(["candidate", "structure-root"]);
    expect(entries.every((e) => e.entryKind !== "route")).toBe(true);
  });

  it("classifies a route handler that is also exported as precise, not twice", () => {
    const handler = sym("HandlePay", "public");
    const entries = identifyEntries({ routes: [route("/pay", handler)], symbols: [handler], callEdges: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryClass).toBe("precise");
  });

  it("is deterministic — the same input yields the same order", () => {
    const a = sym("Aaa", "public");
    const b = sym("Bbb", "public");
    const input: EntryInput = { routes: [], symbols: [b, a], callEdges: [] };
    const first = identifyEntries(input).map((e) => e.entryKey);
    const second = identifyEntries(input).map((e) => e.entryKey);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });
});

describe("buildEntryTraces", () => {
  it("traces from every entry and reports a traceability rate", () => {
    const handler = sym("HandleOrders", "public");
    const service = sym("orderService", "private");
    const repo = sym("orderRepo", "private");
    const lonely = sym("PublicButLeaf", "public");
    const input: EntryInput = {
      routes: [route("/orders", handler)],
      symbols: [handler, service, repo, lonely],
      callEdges: [edge(handler, service), edge(service, repo)],
    };
    const result = buildEntryTraces(input);
    expect(result.traceability.total).toBe(2); // handler (precise) + lonely (candidate)
    expect(result.traceability.precise).toBe(1);
    expect(result.traceability.candidate).toBe(1);
    // the handler reaches service+repo; the lonely leaf reaches nothing
    expect(result.traceability.reachable).toBe(1);
    expect(result.traceability.rate).toBeCloseTo(0.5);
    const handlerTrace = result.traces.find((t) => t.entryClass === "precise")!;
    expect(handlerTrace.steps.map((s) => s.name)).toContain("orderRepo");
  });

  it("records an unresolved call rather than reporting no calls", () => {
    const handler = sym("HandleThing", "public");
    const input: EntryInput = {
      routes: [route("/thing", handler)],
      symbols: [handler],
      callEdges: [edge(handler, null, "dynamicDispatch")],
    };
    const result = buildEntryTraces(input);
    const trace = result.traces[0]!;
    expect(trace.truncation).toBe("unresolved-edge");
    expect(trace.truncationDetail).toContain("dynamicDispatch");
    expect(trace.partial).toBe(true);
  });

  it("has a zero rate and no entries for an empty graph, not a division error", () => {
    const result = buildEntryTraces({ routes: [], symbols: [], callEdges: [] });
    expect(result.traceability).toMatchObject({ total: 0, rate: 0 });
    expect(result.traces).toEqual([]);
  });
});
