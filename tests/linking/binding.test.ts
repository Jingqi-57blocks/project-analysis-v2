import { describe, expect, it } from "vitest";

import { inferBaseBindings, linkCallsScoped } from "../../engine/linking/binding.js";
import { linkCalls } from "../../engine/linking/link.js";
import { lineRef, resolved } from "../../engine/structural/provenance.js";
import type { OutboundCallRecord, RouteRecord } from "../../engine/structural/boundaries.js";

function call(
  base: string | null,
  path: string,
  method: string | null = "GET",
  line = 1,
): OutboundCallRecord {
  return {
    rootName: "ui",
    target: path,
    kind: "http",
    method,
    callerSymbolId: null,
    baseIdentifier: base,
    provenance: resolved(lineRef("ui", "src/api.ts", line), "high"),
  };
}

function route(rootName: string, method: string | null, path: string): RouteRecord {
  return {
    rootName,
    method,
    path,
    surface: "server",
    handlerSymbolId: null,
    handlerName: null,
    handlerCandidates: [],
    middleware: [],
    provenance: resolved(lineRef(rootName, "routes.go", 1), "high"),
  };
}

const LOW_BAR = { majority: 0.6, minimumMatches: 2 };

describe("inferBaseBindings", () => {
  it("binds a base to the service whose routes its calls fit", () => {
    const bindings = inferBaseBindings(
      [call("appRunnerApi", "/v2/leaves"), call("appRunnerApi", "/v2/worklogs")],
      [route("svc-v2", "GET", "/v2/leaves"), route("svc-v2", "GET", "/v2/worklogs")],
      LOW_BAR,
    );

    expect(bindings[0]).toMatchObject({
      baseIdentifier: "appRunnerApi",
      boundRoot: "svc-v2",
      matched: 2,
    });
    expect(bindings[0]!.reason).toContain("svc-v2");
  });

  it("refuses to bind when the calls fit two services evenly", () => {
    // A wrong binding draws a flow between services that never talk, and a
    // drawn arrow is believed.
    const bindings = inferBaseBindings(
      [call("mainApi", "/worklogs"), call("mainApi", "/reviews")],
      [route("svc-a", "GET", "/worklogs"), route("svc-b", "GET", "/reviews")],
      LOW_BAR,
    );

    expect(bindings[0]!.boundRoot).toBeNull();
    expect(bindings[0]!.reason).toContain("no clear majority");
    expect(bindings[0]!.evidence).toHaveLength(2);
  });

  it("refuses to bind on too little evidence, however unanimous", () => {
    const bindings = inferBaseBindings([call("rareApi", "/v2/leaves")], [
      route("svc-v2", "GET", "/v2/leaves"),
    ]);

    expect(bindings[0]!.boundRoot).toBeNull();
    expect(bindings[0]!.reason).toContain("below the");
  });

  it("keeps the per-root counts, so the decision can be checked", () => {
    const bindings = inferBaseBindings(
      [call("api", "/v2/a"), call("api", "/v2/b"), call("api", "/shared")],
      [
        route("svc-a", "GET", "/v2/a"),
        route("svc-a", "GET", "/v2/b"),
        route("svc-a", "GET", "/shared"),
        route("svc-b", "GET", "/shared"),
      ],
      LOW_BAR,
    );

    expect(bindings[0]!.boundRoot).toBe("svc-a");
    expect(bindings[0]!.evidence).toEqual([
      { rootName: "svc-a", matches: 3 },
      { rootName: "svc-b", matches: 1 },
    ]);
  });

  it("counts a call once per service, however many of its routes fit", () => {
    // Otherwise a service with many similar patterns outvotes the right one
    // on the strength of a single call.
    const bindings = inferBaseBindings(
      [call("api", "/v2/x"), call("api", "/v2/y")],
      [
        route("noisy", "GET", "/v2/:a"),
        route("noisy", null, "/v2/:b"),
        route("noisy", "GET", "/*any"),
        route("exact", "GET", "/v2/x"),
        route("exact", "GET", "/v2/y"),
      ],
      LOW_BAR,
    );

    expect(bindings[0]!.evidence).toEqual([
      { rootName: "exact", matches: 2 },
      { rootName: "noisy", matches: 2 },
    ]);
  });

  it("never counts a call toward its own root", () => {
    const bindings = inferBaseBindings(
      [call("api", "/v2/leaves"), call("api", "/v2/leaves")],
      [route("ui", "GET", "/v2/leaves")],
      LOW_BAR,
    );

    expect(bindings[0]!.boundRoot).toBeNull();
    expect(bindings[0]!.matched).toBe(0);
  });

  it("ignores calls with no base, which carry no evidence about one", () => {
    expect(inferBaseBindings([call(null, "/v2/leaves")], [route("svc", "GET", "/v2/leaves")])).toEqual(
      [],
    );
  });
});

describe("linkCallsScoped", () => {
  const twoBackends = [
    route("svc-v2", "GET", "/v2/worklogs"),
    route("legacy", "GET", "/v2/worklogs"),
  ];

  it("resolves a path two services serve, using the base the call was written against", () => {
    const calls = [
      call("appRunnerApi", "/v2/worklogs"),
      call("appRunnerApi", "/v2/leaves"),
      call("appRunnerApi", "/v2/leaves"),
    ];
    const routes = [...twoBackends, route("svc-v2", "GET", "/v2/leaves")];
    const bindings = inferBaseBindings(calls, routes, LOW_BAR);

    expect(bindings[0]!.boundRoot).toBe("svc-v2");

    const scoped = linkCallsScoped(calls, routes, bindings, linkCalls);
    const worklog = scoped.links.find((link) => link.toPath === "/v2/worklogs");
    expect(worklog?.toRoot).toBe("svc-v2");
    expect(scoped.unlinked).toEqual([]);

    // Unscoped, the same call is ambiguous — the binding is what settles it.
    expect(linkCalls(calls, routes).unlinked.some((u) => u.reason === "ambiguous-match")).toBe(true);
  });

  it("leaves an unbound base's calls with the ambiguity they genuinely have", () => {
    const calls = [call("mixedApi", "/v2/worklogs")];
    const scoped = linkCallsScoped(calls, twoBackends, [], linkCalls);

    expect(scoped.links).toEqual([]);
    expect(scoped.unlinked[0]!.reason).toBe("ambiguous-match");
  });

  it("accounts for every call, bound or not", () => {
    const calls = [call("appRunnerApi", "/v2/leaves"), call(null, "/v2/nowhere")];
    const routes = [route("svc-v2", "GET", "/v2/leaves")];
    const bindings = inferBaseBindings(
      [...calls, call("appRunnerApi", "/v2/leaves")],
      routes,
      LOW_BAR,
    );

    const scoped = linkCallsScoped(calls, routes, bindings, linkCalls);
    expect(scoped.links.length + scoped.unlinked.length).toBe(scoped.considered);
    expect(scoped.considered).toBe(2);
  });

  it("does not link a bound call to a route in a different service", () => {
    const calls = [call("authApi", "/v2/leaves"), call("authApi", "/oauth/token", "POST")];
    const routes = [
      route("auth", "POST", "/oauth/token"),
      route("auth", "POST", "/oauth/authorize"),
      route("svc-v2", "GET", "/v2/leaves"),
    ];
    const bindings = [
      {
        baseIdentifier: "authApi",
        fromRoot: "ui",
        boundRoot: "auth",
        matched: 5,
        considered: 5,
        evidence: [{ rootName: "auth", matches: 5 }],
        reason: "bound for this test",
      },
    ];

    const scoped = linkCallsScoped(calls, routes, bindings, linkCalls);
    expect(scoped.links.map((link) => link.toRoot)).toEqual(["auth"]);
    expect(scoped.unlinked[0]!.reason).toBe("no-matching-route");
  });
});

describe("method matching", () => {
  it("separates two routes that differ only by method", () => {
    const routes = [route("svc", "GET", "/v2/leaves"), route("svc", "POST", "/v2/leaves")];
    const result = linkCalls([call(null, "/v2/leaves", "POST")], routes);

    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.toMethod).toBe("POST");
  });

  it("lets a route that answers any method match a call that states one", () => {
    const result = linkCalls([call(null, "/health", "GET")], [route("svc", null, "/health")]);
    expect(result.links).toHaveLength(1);
  });

  it("lets a call that states no method match any route", () => {
    const result = linkCalls([call(null, "/health", null)], [route("svc", "GET", "/health")]);
    expect(result.links).toHaveLength(1);
  });
});
