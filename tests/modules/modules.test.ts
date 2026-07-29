import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, buildTraces, type Trace } from "../../engine/modules/trace.js";
import {
  assignDispositions,
  qualifiedFile,
  formComponents,
  formModules,
  looksInfrastructural,
} from "../../engine/modules/form.js";
import { symbolId, type SymbolId } from "../../engine/structural/identity.js";
import { declared, inferred, lineRef } from "../../engine/structural/provenance.js";
import type { CallEdgeRecord, SymbolRecord } from "../../engine/structural/code.js";
import type { RouteRecord } from "../../engine/structural/boundaries.js";
import type { ModuleContainmentRecord } from "../../engine/structural/dependencies.js";

function sym(name: string, relPath = "a.go"): SymbolRecord {
  return {
    id: symbolId({ rootName: "svc", relPath, kind: "function", qualifiedName: name, signature: null }),
    name,
    qualifiedName: name,
    kind: "function",
    visibility: "unknown",
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

function route(path: string, handler: SymbolRecord | null, rootName = "svc"): RouteRecord {
  return {
    rootName,
    method: "GET",
    path,
    handlerSymbolId: handler?.id ?? null,
    handlerName: handler?.name ?? null,
    handlerCandidates: [],
    middleware: [],
    provenance: inferred(lineRef(rootName, "routes.go", 3), "low"),
  };
}

describe("bounded traversal", () => {
  it("stops on a cycle instead of walking forever", () => {
    const a = sym("HandleA");
    const b = sym("HandleB");
    const result = buildTraces({
      routes: [route("/a", a)],
      symbols: [a, b],
      callEdges: [edge(a, b), edge(b, a)],
    });

    expect(result.traces[0]!.truncation).toBe("cycle");
    expect(result.traces[0]!.partial).toBe(true);
  });

  it("does not call a diamond a cycle", () => {
    // Two branches converging on one shared helper is ordinary structure.
    // Calling it a cycle marks a complete trace as truncated and inflates the
    // partial-trace signal on a very common code shape.
    const a = sym("Handle");
    const b = sym("BranchB");
    const c = sym("BranchC");
    const d = sym("Shared");

    const result = buildTraces({
      routes: [route("/a", a)],
      symbols: [a, b, c, d],
      callEdges: [edge(a, b), edge(a, c), edge(b, d), edge(c, d)],
    });

    expect(result.traces[0]!.steps).toHaveLength(4);
    expect(result.traces[0]!.truncation).toBe("completed");
    expect(result.traces[0]!.partial).toBe(false);
  });

  it("stops at the depth limit", () => {
    const chain = Array.from({ length: 10 }, (_, i) => sym(`Step${i}`));
    const edges = chain.slice(0, -1).map((from, i) => edge(from, chain[i + 1]!));

    const result = buildTraces(
      { routes: [route("/a", chain[0]!)], symbols: chain, callEdges: edges },
      { ...DEFAULT_LIMITS, maxDepth: 3 },
    );

    expect(result.traces[0]!.truncation).toBe("max-depth");
    expect(Math.max(...result.traces[0]!.steps.map((s) => s.depth))).toBeLessThanOrEqual(3);
  });

  it("refuses to follow a symbol with enormous fan-out", () => {
    // A symbol calling everything is a shared helper, not a step in one
    // feature's story. Following it pulls the whole project into the trace.
    const entry = sym("Handle");
    const many = Array.from({ length: 40 }, (_, i) => sym(`Callee${i}`));
    const result = buildTraces(
      {
        routes: [route("/a", entry)],
        symbols: [entry, ...many],
        callEdges: many.map((callee) => edge(entry, callee)),
      },
      { ...DEFAULT_LIMITS, maxBranches: 5 },
    );

    expect(result.traces[0]!.truncation).toBe("max-branches");
    expect(result.traces[0]!.truncationDetail).toContain("outgoing calls");
  });

  it("stops at an unresolved edge rather than inventing a continuation", () => {
    // A trace that walks past an unknown is fiction from that point on.
    const entry = sym("Handle");
    const result = buildTraces({
      routes: [route("/a", entry)],
      symbols: [entry],
      callEdges: [edge(entry, null, "somethingDynamic")],
    });

    expect(result.traces[0]!.truncation).toBe("unresolved-edge");
    expect(result.traces[0]!.truncationDetail).toContain("somethingDynamic");
  });

  it("marks a fully walked trace as complete and not partial", () => {
    const a = sym("Handle");
    const b = sym("Save");
    const result = buildTraces({ routes: [route("/a", a)], symbols: [a, b], callEdges: [edge(a, b)] });

    expect(result.traces[0]!.truncation).toBe("completed");
    expect(result.traces[0]!.partial).toBe(false);
  });

  it("accounts for an entry point it could not trace", () => {
    const result = buildTraces({ routes: [route("/a", null)], symbols: [], callEdges: [] });

    expect(result.traces).toEqual([]);
    expect(result.untraced).toHaveLength(1);
    expect(result.untraced[0]!.reason).toContain("not linked to a handler");
    expect(result.entryPoints).toBe(1);
  });

  it("accounts for every entry point, traced or not", () => {
    const a = sym("Handle");
    const result = buildTraces({
      routes: [route("/a", a), route("/b", null)],
      symbols: [a],
      callEdges: [],
    });

    expect(result.traces.length + result.untraced.length).toBe(result.entryPoints);
  });

  it("records each step's resolution class", () => {
    const a = sym("Handle");
    const b = sym("Save");
    const result = buildTraces({ routes: [route("/a", a)], symbols: [a, b], callEdges: [edge(a, b)] });
    expect(result.traces[0]!.steps.every((s) => s.resolution === "declared")).toBe(true);
  });
});

describe("what must never merge modules", () => {
  it("recognizes infrastructural names", () => {
    for (const name of ["authMiddleware", "Logger", "dbConnection", "configUtil", "sharedHelper"]) {
      expect(looksInfrastructural(name), name).toBe(true);
    }
    expect(looksInfrastructural("PlaceOrder")).toBe(false);
  });

  it("does not merge two features that only share auth middleware", () => {
    // Every authenticated route shares the auth middleware. If that counted,
    // the whole project would collapse into one module.
    const auth = sym("authMiddleware", "auth.go");
    const orders = sym("PlaceOrder", "orders.go");
    const billing = sym("ChargeCard", "billing.go");

    const traces: Trace[] = [
      {
        entryKey: "svc:GET /orders",
        entryRoot: "svc",
        entryMethod: "GET",
        entryPath: "/orders",
        steps: [
          { symbolId: orders.id, name: "PlaceOrder", depth: 0, rootName: "svc", resolution: "declared" },
          { symbolId: auth.id, name: "authMiddleware", depth: 1, rootName: "svc", resolution: "declared" },
        ],
        truncation: "completed",
        truncationDetail: null,
        partial: false,
      },
      {
        entryKey: "svc:GET /billing",
        entryRoot: "svc",
        entryMethod: "GET",
        entryPath: "/billing",
        steps: [
          { symbolId: billing.id, name: "ChargeCard", depth: 0, rootName: "svc", resolution: "declared" },
          { symbolId: auth.id, name: "authMiddleware", depth: 1, rootName: "svc", resolution: "declared" },
        ],
        truncation: "completed",
        truncationDetail: null,
        partial: false,
      },
    ];

    const modules = formModules(traces);
    expect(modules).toHaveLength(2);
    expect(modules.map((m) => m.name).sort()).toEqual(["billing", "orders"]);
  });

  it("excludes infrastructure symbols from a module's membership", () => {
    const auth = sym("authMiddleware", "auth.go");
    const orders = sym("PlaceOrder", "orders.go");
    const modules = formModules([
      {
        entryKey: "svc:GET /orders",
        entryRoot: "svc",
        entryMethod: "GET",
        entryPath: "/orders",
        steps: [
          { symbolId: orders.id, name: "PlaceOrder", depth: 0, rootName: "svc", resolution: "declared" },
          { symbolId: auth.id, name: "authMiddleware", depth: 1, rootName: "svc", resolution: "declared" },
        ],
        truncation: "completed",
        truncationDetail: null,
        partial: false,
      },
    ]);

    expect(modules[0]!.symbolIds).toContain(orders.id);
    expect(modules[0]!.symbolIds).not.toContain(auth.id);
  });

  it("does not collapse every feature into one when routes share a prefix", () => {
    // Most APIs prefix every route with /api or /api/v1. Anchoring on the
    // first segment would give every feature the same anchor — the same
    // useless outcome the shared-middleware rule exists to prevent.
    const make = (path: string): Trace => ({
      entryKey: `svc:GET ${path}`,
      entryRoot: "svc",
      entryMethod: "GET",
      entryPath: path,
      steps: [],
      truncation: "completed",
      truncationDetail: null,
      partial: false,
    });

    const modules = formModules([
      make("/api/orders/:id"),
      make("/api/users/:id/profile"),
      make("/api/payments/charge"),
    ]);

    expect(modules.map((m) => m.name).sort()).toEqual(["orders", "payments", "users"]);
  });

  it("gives a module a stable id that survives a path change", () => {
    // An entry-point path as an id would mint a new module the day /orders
    // became /v2/orders, for a feature nobody changed.
    const make = (path: string): Trace => ({
      entryKey: "svc:GET /orders",
      entryRoot: "svc",
      entryMethod: "GET",
      entryPath: path,
      steps: [],
      truncation: "completed",
      truncationDetail: null,
      partial: false,
    });

    expect(formModules([make("/orders")])[0]!.id).toBe(formModules([make("/v2/orders")])[0]!.id);
  });

  it("states which signal justified the grouping", () => {
    const modules = formModules([
      {
        entryKey: "svc:GET /orders",
        entryRoot: "svc",
        entryMethod: "GET",
        entryPath: "/orders",
        steps: [],
        truncation: "completed",
        truncationDetail: null,
        partial: false,
      },
    ]);
    expect(modules[0]!.groupingSignal).toContain("orders");
  });
});

describe("components come from structure, not leftovers", () => {
  function containment(memberPath: string, containerPath = "."): ModuleContainmentRecord {
    return {
      rootName: "svc",
      containerPath,
      memberPath,
      kind: "folder",
      provenance: declared(lineRef("svc", memberPath, 1)),
    };
  }

  it("identifies a component with no behavioural trace reaching it", () => {
    // The exit criterion: a component exists from its dependency shape alone.
    const components = formComponents({
      containment: [containment("shared"), containment("shared/log.go", "shared")],
      dependencies: [],
      symbols: [],
    });

    expect(components).toHaveLength(1);
    expect(components[0]!.name).toBe("shared");
    expect(components[0]!.signals).toContain("folder containment");
  });

  it("notes when a component's name indicates shared infrastructure", () => {
    const components = formComponents({
      containment: [containment("auth"), containment("auth/token.go", "auth")],
      dependencies: [],
      symbols: [],
    });
    expect(components[0]!.signals).toContain("name indicates shared infrastructure");
  });

  it("ignores a container with no members", () => {
    expect(formComponents({ containment: [containment("empty")], dependencies: [], symbols: [] })).toEqual(
      [],
    );
  });
});

describe("disposition accounting", () => {
  it("gives every file exactly one disposition, summing to the total", () => {
    // Overlapping sets cannot be summed, which is why disposition is separate
    // from membership.
    const orders = sym("PlaceOrder", "orders.go");
    const auth = sym("authMiddleware", "auth.go");
    const symbols = new Map([orders, auth].map((s) => [s.id, s] as const));

    const traces: Trace[] = [
      {
        entryKey: "k",
        entryRoot: "svc",
        entryMethod: "GET",
        entryPath: "/orders",
        steps: [
          { symbolId: orders.id, name: "PlaceOrder", depth: 0, rootName: "svc", resolution: "declared" },
          { symbolId: auth.id, name: "authMiddleware", depth: 1, rootName: "svc", resolution: "declared" },
        ],
        truncation: "completed",
        truncationDetail: null,
        partial: false,
      },
    ];

    const files = ["orders.go", "auth.go", "vendor/lib.go", "unused.go"].map((f) =>
      qualifiedFile("svc", f),
    );
    const { dispositions, counts } = assignDispositions(files, traces, symbols, [
      { id: "c1", name: "vendor", rootName: "svc", signals: [], memberPaths: ["vendor/lib.go"] },
    ]);

    expect(dispositions.get(qualifiedFile("svc", "orders.go"))).toBe("behavioral-source");
    expect(dispositions.get(qualifiedFile("svc", "auth.go"))).toBe("shared-infrastructure");
    expect(dispositions.get(qualifiedFile("svc", "vendor/lib.go"))).toBe("technical-only");
    expect(dispositions.get(qualifiedFile("svc", "unused.go"))).toBe("unclassified");

    expect(
      counts.behavioralSource + counts.technicalOnly + counts.sharedInfrastructure + counts.unclassified,
    ).toBe(counts.total);
    expect(counts.total).toBe(files.length);
  });

  it("treats unclassified as a state rather than a failure", () => {
    const { counts } = assignDispositions(
      [qualifiedFile("svc", "a.go")],
      [],
      new Map<SymbolId, SymbolRecord>(),
      [],
    );
    expect(counts.unclassified).toBe(1);
    expect(counts.total).toBe(1);
  });

  it("keeps two roots' identically-named files apart", () => {
    // Every Go service has main.go. Keying on the path alone lets the second
    // silently overwrite the first, so a file vanishes and the total it is
    // counted in comes out short.
    const traced = sym("Handle", "main.go");
    const symbols = new Map([[traced.id, traced]]);

    const traces: Trace[] = [
      {
        entryKey: "k",
        entryRoot: "svc-a",
        entryMethod: "GET",
        entryPath: "/x",
        steps: [
          { symbolId: traced.id, name: "Handle", depth: 0, rootName: "svc", resolution: "declared" },
        ],
        truncation: "completed",
        truncationDetail: null,
        partial: false,
      },
    ];

    const files = [qualifiedFile("svc-a", "main.go"), qualifiedFile("svc-b", "main.go")];
    const { dispositions, counts } = assignDispositions(files, traces, symbols, []);

    expect(dispositions.size).toBe(2);
    expect(counts.total).toBe(2);
    expect(dispositions.get(qualifiedFile("svc-b", "main.go"))).toBe("unclassified");
  });
});
