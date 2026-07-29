import { describe, expect, it } from "vitest";

import { consolidateRoutes } from "../../engine/structural/routededupe.js";
import { inferred, lineRef, resolved } from "../../engine/structural/provenance.js";
import type { AssembledModel, AssembledRecord } from "../../engine/structural/assemble.js";
import type { RouteRecord } from "../../engine/structural/boundaries.js";

function routeRecord(
  providerId: string,
  route: Partial<RouteRecord> & { path: string },
  line = 26,
): AssembledRecord {
  const full: RouteRecord = {
    rootName: "svc",
    method: "GET",
    handlerSymbolId: null,
    handlerName: null,
    handlerCandidates: [],
    middleware: [],
    provenance:
      providerId === "framework-routes"
        ? resolved(lineRef("svc", "handler.go", line), "high")
        : inferred(lineRef("svc", "handler.go", line), "low"),
    ...route,
  };
  return {
    kind: "route",
    key: `svc|${full.method}|${full.path}`,
    record: full,
    attributions: [{ providerId, providerVersion: "1.0.0" }],
    conflicts: [],
    precedenceReason: null,
  };
}

function model(records: AssembledRecord[]): AssembledModel {
  return { rootName: "svc", records, gaps: [], failures: [] };
}

describe("consolidateRoutes", () => {
  it("folds a prefix-less inference into the full path from the same registration line", () => {
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/oauth/authorize" }),
        routeRecord("codegraph", { path: "/authorize" }),
      ]),
    );

    const routes = consolidated.records.filter((r) => r.kind === "route");
    expect(routes).toHaveLength(1);
    expect((routes[0]!.record as RouteRecord).path).toBe("/oauth/authorize");
    expect(routes[0]!.attributions.map((a) => a.providerId).sort()).toEqual([
      "codegraph",
      "framework-routes",
    ]);
    // The losing path survives as a conflict, not as a second route.
    expect(routes[0]!.conflicts.some((c) => c.field === "path")).toBe(true);
  });

  it("absorbs across shifted lines in a claimed root — wrappers move CodeGraph's line", () => {
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/oauth/token" }, 30),
        routeRecord("codegraph", { path: "/token" }, 31),
      ]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(1);
  });

  it("leaves a genuinely different route alone, even at the same line", () => {
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/oauth/authorize" }),
        routeRecord("codegraph", { path: "/something-else" }),
      ]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(2);
  });

  it("does not touch inferred routes in a root the framework provider never claimed", () => {
    // Suppressing CodeGraph's view where nothing better exists would silently
    // discard real routes.
    const consolidated = consolidateRoutes(
      model([routeRecord("codegraph", { path: "/authorize" })]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(1);
  });

  it("folds a null-method inference into a specific method", () => {
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/oauth/authorize", method: "POST" }),
        routeRecord("codegraph", { path: "/authorize", method: null }),
      ]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(1);
  });

  it("folds a mount-root registration, whose literal path is a suffix of nothing", () => {
    // Express's router.delete('/') mounted at /worklogs serves /worklogs; the
    // registration site shows only "/".
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/worklogs", method: "DELETE" }),
        routeRecord("codegraph", { path: "/", method: "DELETE" }),
      ]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(1);
  });

  it("treats a trailing slash as the same endpoint", () => {
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/logreport/new_entry", method: "POST" }, 153),
        routeRecord("codegraph", { path: "/new_entry/", method: "POST" }, 153),
      ]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(1);
  });

  it("drops a router mount, which serves no request, and records that it did", () => {
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/worklogs/me", method: "GET" }),
        routeRecord("codegraph", { path: "/worklogs", method: "USE" }, 94),
      ]),
    );

    const routes = consolidated.records.filter((r) => r.kind === "route");
    expect(routes).toHaveLength(1);
    expect((routes[0]!.record as RouteRecord).method).toBe("GET");
    expect(consolidated.failures[0]!.reason).toContain("not an endpoint");
  });

  it("keeps a mount in a root no reader expanded, since nothing replaced it", () => {
    const consolidated = consolidateRoutes(
      model([routeRecord("codegraph", { path: "/worklogs", method: "USE" })]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(1);
    expect(consolidated.failures).toEqual([]);
  });

  it("does not fold a bare root path across different lines of a file", () => {
    // "/" is a suffix of everything, which is precise at one registration site
    // and a coin-flip across a file.
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/worklogs", method: "DELETE" }, 10),
        routeRecord("codegraph", { path: "/", method: "DELETE" }, 99),
      ]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(2);
  });

  it("never folds two directly-observed routes into each other", () => {
    const consolidated = consolidateRoutes(
      model([
        routeRecord("framework-routes", { path: "/v2/leaves" }),
        routeRecord("framework-routes", { path: "/leaves" }),
      ]),
    );

    expect(consolidated.records.filter((r) => r.kind === "route")).toHaveLength(2);
  });
});
