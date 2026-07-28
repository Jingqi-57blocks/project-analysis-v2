import { describe, expect, it } from "vitest";

import { linkCalls, pathOf, rootDependencies, routeMatches } from "../../engine/linking/link.js";
import { inferred, lineRef, unresolved } from "../../engine/structural/provenance.js";
import type { OutboundCallRecord, RouteRecord } from "../../engine/structural/boundaries.js";

function call(rootName: string, target: string | null): OutboundCallRecord {
  const source = lineRef(rootName, "client.ts", 10);
  return {
    rootName,
    target,
    kind: "http",
    callerSymbolId: null,
    provenance: target === null ? unresolved(source, "built at runtime") : inferred(source, "medium"),
  };
}

function route(rootName: string, method: string | null, path: string): RouteRecord {
  const source = lineRef(rootName, "routes.go", 20);
  return {
    rootName,
    method,
    path,
    handlerSymbolId: null,
    handlerName: null,
    middleware: [],
    provenance: inferred(source, "low"),
  };
}

describe("pathOf", () => {
  it("takes the path from an absolute URL", () => {
    expect(pathOf("https://api.example.com/v1/users")).toBe("/v1/users");
  });

  it("treats a URL with no path as the root path", () => {
    expect(pathOf("https://api.example.com")).toBe("/");
  });

  it("drops the query and fragment, which a route never matches on", () => {
    expect(pathOf("https://x.dev/users?page=2#top")).toBe("/users");
    expect(pathOf("/users?page=2")).toBe("/users");
  });

  it("accepts a bare path", () => {
    expect(pathOf("/v1/orders")).toBe("/v1/orders");
  });

  it("returns null for something that is not a path at all", () => {
    expect(pathOf("not-a-url")).toBeNull();
  });
});

describe("routeMatches", () => {
  it("matches an exact path", () => {
    expect(routeMatches("/users", "/users")).toBe(true);
    expect(routeMatches("/users", "/orders")).toBe(false);
  });

  it("matches a parameter against exactly one segment", () => {
    expect(routeMatches("/users/:id", "/users/42")).toBe(true);
    expect(routeMatches("/users/:id", "/users/42/orders")).toBe(false);
    expect(routeMatches("/users/:id", "/users")).toBe(false);
  });

  it("supports the brace and angle parameter spellings", () => {
    expect(routeMatches("/users/{id}", "/users/42")).toBe(true);
    expect(routeMatches("/users/<id>", "/users/42")).toBe(true);
  });

  it("matches a wildcard against the rest of the path", () => {
    expect(routeMatches("/static/*", "/static/a/b/c")).toBe(true);
    expect(routeMatches("/swagger/*any", "/swagger/index.html")).toBe(true);
  });

  it("ignores a trailing slash on either side", () => {
    expect(routeMatches("/users/", "/users")).toBe(true);
    expect(routeMatches("/users", "/users/")).toBe(true);
  });

  it("does not let route text act as a regular expression", () => {
    // A pattern is user data. Building a regex from it would let a route's own
    // text change how matching behaves.
    expect(routeMatches("/a.c", "/abc")).toBe(false);
    expect(routeMatches("/a+", "/aaa")).toBe(false);
  });
});

describe("linkCalls", () => {
  it("links a call to a route in another root", () => {
    const result = linkCalls(
      [call("ui", "https://api.example.com/users")],
      [route("api", "GET", "/users")],
    );

    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ fromRoot: "ui", toRoot: "api", toPath: "/users" });
    expect(result.unlinked).toEqual([]);
  });

  it("never links a call to a route in its own root", () => {
    // An in-process call does not cross a service boundary, and reporting one
    // as a cross-root link would invent an integration that does not exist.
    const result = linkCalls([call("api", "https://api.example.com/users")], [route("api", "GET", "/users")]);

    expect(result.links).toEqual([]);
    expect(result.unlinked[0]!.reason).toBe("no-matching-route");
  });

  it("records a link as inferred, never as fact", () => {
    // A link joins a URL literal to a route pattern; neither side states the
    // other exists.
    const result = linkCalls([call("ui", "https://api/users")], [route("api", "GET", "/users")]);
    expect(result.links[0]!.provenance.resolutionClass).toBe("inferred");
  });

  it("gives a wildcard match lower confidence than an exact one", () => {
    const exact = linkCalls([call("ui", "https://api/users")], [route("api", "GET", "/users")]);
    const wild = linkCalls([call("ui", "https://api/anything")], [route("api", "GET", "/*any")]);

    const exactProvenance = exact.links[0]!.provenance;
    const wildProvenance = wild.links[0]!.provenance;
    expect(exactProvenance.resolutionClass === "inferred" && exactProvenance.confidence).toBe("medium");
    expect(wildProvenance.resolutionClass === "inferred" && wildProvenance.confidence).toBe("low");
  });

  it("prefers the more specific route over a wildcard", () => {
    const result = linkCalls(
      [call("ui", "https://api/users")],
      [route("api", "GET", "/*any"), route("api", "GET", "/users")],
    );

    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.toPath).toBe("/users");
  });

  it("keeps an ambiguous match unresolved, listing the candidates", () => {
    // Two roots declaring the same path is a real finding — often a genuine
    // duplication — and picking one would hide it behind a confident answer.
    const result = linkCalls(
      [call("ui", "https://api/users")],
      [route("api-a", "GET", "/users"), route("api-b", "GET", "/users")],
    );

    expect(result.links).toEqual([]);
    expect(result.unlinked[0]!.reason).toBe("ambiguous-match");
    expect(result.unlinked[0]!.candidates).toHaveLength(2);
  });

  it("records an unresolved destination rather than dropping the call", () => {
    const result = linkCalls([call("ui", null)], [route("api", "GET", "/users")]);
    expect(result.unlinked[0]!.reason).toBe("target-not-resolved");
  });

  it("records a call to a path no root declares", () => {
    // Pointing outside the workspace is a fact about the system, not a failure
    // of the matcher.
    const result = linkCalls([call("ui", "https://stripe.com/v1/charges")], [route("api", "GET", "/users")]);
    expect(result.unlinked[0]!.reason).toBe("no-matching-route");
  });

  it("records a destination that is not a path at all", () => {
    const result = linkCalls([call("ui", "some-queue-name")], []);
    expect(result.unlinked[0]!.reason).toBe("external-destination");
  });

  it("accounts for every call considered", () => {
    // linked + unlinked = considered, by construction.
    const calls = [
      call("ui", "https://api/users"),
      call("ui", null),
      call("ui", "https://stripe.com/x"),
      call("ui", "not-a-url"),
    ];
    const result = linkCalls(calls, [route("api", "GET", "/users")]);

    expect(result.considered).toBe(4);
    expect(result.links.length + result.unlinked.length).toBe(result.considered);
  });

  it("links nothing when there are no routes at all", () => {
    const result = linkCalls([call("ui", "https://api/users")], []);
    expect(result.links).toEqual([]);
    expect(result.unlinked).toHaveLength(1);
  });
});

describe("rootDependencies", () => {
  it("counts calls between each pair of roots", () => {
    const result = linkCalls(
      [call("ui", "https://api/users"), call("ui", "https://api/orders"), call("worker", "https://api/users")],
      [route("api", "GET", "/users"), route("api", "GET", "/orders")],
    );

    expect(rootDependencies(result)).toEqual([
      { from: "ui", to: "api", calls: 2 },
      { from: "worker", to: "api", calls: 1 },
    ]);
  });

  it("reports nothing when nothing linked", () => {
    expect(rootDependencies(linkCalls([call("ui", null)], []))).toEqual([]);
  });
});
