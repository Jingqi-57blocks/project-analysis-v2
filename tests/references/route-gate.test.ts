import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createCodeGraphProvider } from "../../engine/providers/codegraph/provider.js";
import { createGinReader } from "../../engine/providers/frameworkroutes/readers/gin.js";
import { walkRoot } from "../../engine/inventory/walk.js";
import { resolveTarget } from "../../engine/targets/resolve.js";
import {
  everyRouteAccountedFor,
  gradeRoutes,
  type ReferenceRoute,
} from "../../engine/structural/routegate.js";
import { announceSkip } from "../support/targets.js";
import type { RouteRecord } from "../../engine/structural/boundaries.js";

const referencePath = join(process.cwd(), "references", "wcp-auth", "routes.json");
const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
  routes: ReferenceRoute[];
};

function route(method: string | null, path: string): RouteRecord {
  return {
    rootName: "wcp-auth",
    method,
    path,
    surface: "server",
    handlerSymbolId: null,
    handlerName: null,
    handlerCandidates: [],
    middleware: [],
    provenance: {
      resolutionClass: "inferred",
      confidence: "low",
      source: {
        rootName: "wcp-auth",
        relPath: "handler.go",
        startLine: 1,
        endLine: 1,
        startColumn: null,
        endColumn: null,
      },
    },
  };
}

describe("gradeRoutes", () => {
  it("counts an exact method and path match as extracted", () => {
    const grade = gradeRoutes([route("GET", "/oauth/authorize")], [
      { method: "GET", path: "/oauth/authorize", handler: "AuthorizeEntry" },
    ]);

    expect(grade.extracted).toBe(1);
    expect(grade.graded[0]!.reason).toBeNull();
  });

  it("distinguishes a missing group prefix from a route never found", () => {
    // Different failures needing different fixes: one means the registration
    // was seen but its prefix was unresolved, the other means it was never
    // seen at all. Reporting both as missing would hide which is wrong.
    const grade = gradeRoutes(
      [route("GET", "/authorize")],
      [
        { method: "GET", path: "/oauth/authorize", handler: "AuthorizeEntry" },
        { method: "POST", path: "/oauth/token", handler: "TokenDispatch" },
      ],
    );

    expect(grade.pathMismatch).toBe(1);
    expect(grade.missing).toBe(1);
    expect(grade.graded[0]!.reason).toContain("path is incomplete");
    expect(grade.graded[0]!.nearestExtractedPath).toBe("/authorize");
  });

  it("matches the reference's ANY against the model's null method", () => {
    const grade = gradeRoutes([route(null, "/health")], [
      { method: "ANY", path: "/health", handler: null },
    ]);
    expect(grade.extracted).toBe(1);
  });

  it("names the responsible capability gap for a route nobody found", () => {
    const grade = gradeRoutes([], [{ method: "GET", path: "/x", handler: null }], [
      { kind: "route", language: "go", reason: "router-group prefixes are not resolved" },
    ]);

    expect(grade.graded[0]!.reason).toBe("router-group prefixes are not resolved");
  });

  it("reports an extracted route absent from the reference as unexpected", () => {
    const grade = gradeRoutes([route("GET", "/surprise")], []);
    expect(grade.unexpected).toEqual(["GET /surprise"]);
  });

  it("does not count one extracted route against two reference routes", () => {
    const grade = gradeRoutes([route("GET", "/a")], [
      { method: "GET", path: "/a", handler: null },
      { method: "GET", path: "/a", handler: null },
    ]);
    expect(grade.extracted + grade.pathMismatch + grade.missing).toBe(2);
  });
});

describe("everyRouteAccountedFor", () => {
  it("passes when every route is extracted or carries a reason", () => {
    const grade = gradeRoutes([route("GET", "/a")], [
      { method: "GET", path: "/a", handler: null },
      { method: "GET", path: "/b", handler: null },
    ]);
    expect(everyRouteAccountedFor(grade)).toBe(true);
  });

  it("fails when a route is unaccounted for", () => {
    const grade = gradeRoutes([], [{ method: "GET", path: "/x", handler: null }]);
    const silent = {
      ...grade,
      graded: grade.graded.map((g) => ({ ...g, reason: null })),
    };
    expect(everyRouteAccountedFor(silent)).toBe(false);
  });
});

const wcpV2 = resolveTarget("wcp-v2");
if (!wcpV2.ok) announceSkip("route gate on wcp-auth", wcpV2.unavailable.reason);

describe.skipIf(!wcpV2.ok)("the gate against real extraction", () => {
  // Extracted once and shared: indexing plus a callee query per callable
  // symbol costs about half a minute, and re-running it per assertion would
  // triple that for no additional coverage.
  let contribution: ReturnType<ReturnType<typeof createCodeGraphProvider>["extract"]>;
  let grade: ReturnType<typeof gradeRoutes>;

  beforeAll(() => {
    if (!wcpV2.ok) return;
    const root = wcpV2.target.roots.find((r) => r.name === "wcp-auth")!;
    contribution = createCodeGraphProvider().extract({
      name: "wcp-auth",
      path: root.path,
      analyzedFiles: [],
    });
    grade = gradeRoutes(contribution.records.route, reference.routes, contribution.gaps);
  }, 180_000);

  it("accounts for every hand-verified route, one way or the other", () => {
    if (!wcpV2.ok) return;

    // The exit criterion. Not "everything must be extracted" — every route
    // must be accounted for, with the reason named when it was not.
    expect(everyRouteAccountedFor(grade)).toBe(true);
    expect(grade.graded).toHaveLength(reference.routes.length);
  });

  it("records what CodeGraph alone can see: only the route outside a router group is exact", () => {
    if (!wcpV2.ok) return;

    // Pinned deliberately — the coverage matrix's headline finding for routes.
    // The registrations are found, but every route inside a router group gets
    // a path missing its prefix, so what this provider reports is wrong rather
    // than absent. The single exact match is the one route registered outside
    // any group.
    //
    // This measures the CodeGraph adapter in isolation, which is why it still
    // reads 1. The framework-routes reader now supplies the prefixes, and the
    // gate below measures that — the improvement is visible there rather than
    // by editing this number, because the underlying adapter did not change.
    expect(grade.extracted).toBe(1);
    expect(grade.pathMismatch).toBeGreaterThanOrEqual(12);
    expect(grade.extracted + grade.pathMismatch + grade.missing).toBe(reference.routes.length);
  });

  it("marks route paths as inferred, so nothing repeats a possibly-wrong path as fact", () => {
    if (!wcpV2.ok) return;

    expect(contribution.records.route.length).toBeGreaterThan(0);
    for (const extracted of contribution.records.route) {
      expect(extracted.provenance.resolutionClass).toBe("inferred");
    }
  });

  it("does not claim a route the reference does not support without saying so", () => {
    if (!wcpV2.ok) return;
    // Unexpected routes are reported rather than ignored: a provider inventing
    // endpoints is as damaging as one missing them.
    for (const unexpected of grade.unexpected) {
      expect(typeof unexpected).toBe("string");
    }
    expect(grade.unexpected.length).toBeLessThanOrEqual(contribution.records.route.length);
  });
});

describe.skipIf(!wcpV2.ok)("the gate against framework-aware extraction", () => {
  let reading: ReturnType<ReturnType<typeof createGinReader>["read"]>;
  let grade: ReturnType<typeof gradeRoutes>;

  beforeAll(() => {
    if (!wcpV2.ok) return;
    const root = wcpV2.target.roots.find((r) => r.name === "wcp-auth")!;
    const analyzedFiles = walkRoot(root.path).analyzed.map((file) => file.relPath);
    reading = createGinReader().read({ name: "wcp-auth", path: root.path, analyzedFiles });
    grade = gradeRoutes(reading.routes, reference.routes, []);
  }, 60_000);

  it("extracts every hand-verified route with its full path", () => {
    if (!wcpV2.ok) return;

    // The exit criterion for the route gap: not merely accounted for, but
    // right. Every reference route matched exactly, nothing invented, and no
    // path left short of its group prefix.
    expect(grade.extracted).toBe(reference.routes.length);
    expect(grade.pathMismatch).toBe(0);
    expect(grade.missing).toBe(0);
    expect(grade.unexpected).toEqual([]);
  });

  it("states routes it read from a registration as resolved, not inferred", () => {
    if (!wcpV2.ok) return;
    for (const extracted of reading.routes) {
      expect(extracted.provenance.resolutionClass).toBe("resolved");
    }
  });

  it("names the handler behind each route the reference names", () => {
    if (!wcpV2.ok) return;

    const named = reference.routes.filter((r) => r.handler !== null);
    for (const expected of named) {
      const found = reading.routes.find(
        (r) => r.path === expected.path && (r.method ?? "ANY") === expected.method,
      );
      expect(found?.handlerCandidates.join(" ")).toContain(expected.handler!);
    }
  });
});
