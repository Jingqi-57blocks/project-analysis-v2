import { describe, expect, it } from "vitest";

import { resolveHandlers } from "../../engine/linking/handlers.js";
import { symbolId } from "../../engine/structural/identity.js";
import { declared, lineRef, resolved } from "../../engine/structural/provenance.js";
import type { RouteRecord } from "../../engine/structural/boundaries.js";
import type { SymbolRecord } from "../../engine/structural/code.js";

function sym(name: string, relPath: string, qualifiedName?: string): SymbolRecord {
  return {
    id: symbolId({ rootName: "svc", relPath, kind: "function", qualifiedName: qualifiedName ?? name, signature: null }),
    name,
    qualifiedName: qualifiedName ?? name,
    kind: "function",
    visibility: "unknown",
    signature: null,
    containerId: null,
    provenance: declared(lineRef("svc", relPath, 10, 40)),
  };
}

function route(handlerName: string | null, rootName = "svc", candidates?: string[]): RouteRecord {
  return {
    rootName,
    method: "POST",
    path: "/v2/leaves",
    handlerSymbolId: null,
    handlerName,
    handlerCandidates: candidates ?? (handlerName === null ? [] : [handlerName]),
    middleware: [],
    provenance: resolved(lineRef(rootName, "handlers.go", 98), "high"),
  };
}

describe("resolveHandlers", () => {
  it("resolves a package-qualified handler to its unique symbol", () => {
    const creation = sym("Creation", "internal/handlers/leave/router.go");
    const result = resolveHandlers([route("leave.Creation")], [creation]);

    expect(result.routes[0]!.handlerSymbolId).toBe(creation.id);
    expect(result.unresolved).toEqual([]);
  });

  it("uses the package hint to separate same-named functions in different packages", () => {
    const leaveCreation = sym("Creation", "internal/handlers/leave/router.go");
    const orderCreation = sym("Creation", "internal/handlers/order/router.go");

    const result = resolveHandlers([route("leave.Creation")], [leaveCreation, orderCreation]);
    expect(result.routes[0]!.handlerSymbolId).toBe(leaveCreation.id);
  });

  it("refuses to pick between genuinely ambiguous candidates", () => {
    // A trace walked from the wrong handler is fiction with good posture.
    const a = sym("Creation", "internal/leave/a.go");
    const b = sym("Creation", "internal/leave/b.go");

    const result = resolveHandlers([route("leave.Creation")], [a, b]);
    expect(result.routes[0]!.handlerSymbolId).toBeNull();
    expect(result.unresolved[0]!.reason).toContain("2 symbols");
  });

  it("records a handler whose symbol does not exist, with the name kept", () => {
    const result = resolveHandlers([route("leave.Creation")], []);
    expect(result.routes[0]!.handlerSymbolId).toBeNull();
    expect(result.unresolved[0]!.reason).toContain("no symbol");
    expect(result.unresolved[0]!.handlerName).toBe("leave.Creation");
  });

  it("never resolves across roots", () => {
    // Two services can both define leave.Creation.
    const otherRoot: SymbolRecord = {
      ...sym("Creation", "internal/handlers/leave/router.go"),
      provenance: declared({ rootName: "other", relPath: "internal/handlers/leave/router.go", startLine: 10, endLine: 40, startColumn: null, endColumn: null }),
    };

    const result = resolveHandlers([route("leave.Creation")], [otherRoot]);
    expect(result.routes[0]!.handlerSymbolId).toBeNull();
  });

  it("leaves routes with no handler name untouched, without an unresolved entry", () => {
    const result = resolveHandlers([route(null)], []);
    expect(result.routes[0]!.handlerSymbolId).toBeNull();
    expect(result.unresolved).toEqual([]);
  });

  it("falls back to the wrapper when the inner name is not something the repo defines", () => {
    // ginSwagger.WrapHandler(swaggerFiles.Handler): the argument belongs to a
    // library, so the wrapper is what this repository could resolve.
    const wrapper = sym("WrapHandler", "internal/handlers/swagger.go", "ginSwagger.WrapHandler");
    const result = resolveHandlers(
      [route("swaggerFiles.Handler", "svc", ["swaggerFiles.Handler", "ginSwagger.WrapHandler"])],
      [wrapper],
    );

    expect(result.routes[0]!.handlerSymbolId).toBe(wrapper.id);
    expect(result.unresolved).toEqual([]);
  });

  it("reports why every candidate failed, not just the first", () => {
    const result = resolveHandlers(
      [route("a.One", "svc", ["a.One", "b.Two"])],
      [],
    );
    expect(result.unresolved[0]!.reason).toContain("One");
    expect(result.unresolved[0]!.reason).toContain("Two");
  });

  it("resolves an Express service-call identity against the service file's symbols", () => {
    const method = sym(
      "getWorkLogsByUser",
      "services/worklogServices.js",
      "getWorkLogsByUser",
    );
    const result = resolveHandlers([route("worklogService.getWorkLogsByUser")], [method]);
    expect(result.routes[0]!.handlerSymbolId).toBe(method.id);
  });
});
