import { describe, expect, it } from "vitest";

import { assembleFlows } from "../../engine/flows/assemble.js";
import { featureOverviewMermaid, flowToMermaid } from "../../engine/flows/mermaid.js";
import { detectFeatures } from "../../engine/modules/features.js";
import { symbolId } from "../../engine/structural/identity.js";
import { declared, inferred, lineRef, resolved } from "../../engine/structural/provenance.js";
import type { DataAccessRecord, RouteRecord } from "../../engine/structural/boundaries.js";
import type { SymbolRecord } from "../../engine/structural/code.js";
import type { CrossRootLink } from "../../engine/linking/types.js";
import type { FlowInput } from "../../engine/flows/assemble.js";

const HANDLER_FILE = "internal/handlers/leave/router.go";

function symbol(name: string, relPath = HANDLER_FILE): SymbolRecord {
  return {
    id: symbolId({ rootName: "svc", relPath, kind: "function", qualifiedName: name, signature: null }),
    name,
    qualifiedName: name,
    kind: "function",
    visibility: "public",
    signature: null,
    containerId: null,
    provenance: declared(lineRef("svc", relPath, 30, 60)),
  };
}

function route(overrides: Partial<RouteRecord> = {}): RouteRecord {
  return {
    rootName: "svc",
    method: "POST",
    path: "/v2/leaves",
    handlerSymbolId: symbol("Creation").id,
    handlerName: "leave.Creation",
    handlerCandidates: ["leave.Creation"],
    middleware: ["auth.Authentication"],
    provenance: resolved(lineRef("svc", "handlers.go", 98), "high"),
    ...overrides,
  };
}

function access(entity: string, operation: "read" | "write", relPath: string): DataAccessRecord {
  return {
    rootName: "svc",
    entity,
    operation,
    mechanism: "gorm",
    symbolId: null,
    provenance: resolved(lineRef("svc", relPath, 12), "high"),
  };
}

const uiLink: CrossRootLink = {
  fromRoot: "ui",
  fromSymbolId: null,
  target: "/v2/leaves",
  toRoot: "svc",
  toMethod: "POST",
  toPath: "/v2/leaves",
  toHandlerSymbolId: null,
  kind: "http-route",
  provenance: inferred(lineRef("ui", "src/api/leaveApi.ts", 22), "medium"),
};

const leaveFeature = {
  id: "feat_leave",
  weight: 30,
  term: "leave",
  name: "Leave",
  entities: ["wcp_leave"],
  routes: [],
  filePaths: [],
  rootNames: ["svc"],
  signals: ["1 data entities", "27 endpoints"],
};

function input(overrides: Partial<FlowInput> = {}): FlowInput {
  return {
    features: [leaveFeature],
    routes: [route()],
    symbols: [symbol("Creation")],
    links: [uiLink],
    calls: [],
    dataAccess: [
      access("wcp_leave", "write", "internal/handlers/leave/service.go"),
      access("wcp_leave_detail", "write", "internal/handlers/leave/service.go"),
    ],
    validations: [],
    handlerGaps: new Map(),
    ...overrides,
  };
}

describe("assembleFlows", () => {
  it("carries a request from the browser to the tables it writes", () => {
    const { flows } = assembleFlows(input());

    expect(flows).toHaveLength(1);
    expect(flows[0]!.steps.map((step) => `${step.kind}:${step.label}`)).toEqual([
      "frontend-call:ui",
      "route:POST /v2/leaves",
      "handler:Creation",
      "data-access:wcp_leave",
      "data-access:wcp_leave_detail",
    ]);
    expect(flows[0]!.partial).toBe(false);
  });

  it("shows the middleware a route is registered behind as a condition", () => {
    const { flows } = assembleFlows(input());
    expect(flows[0]!.steps[1]!.conditions).toEqual(["middleware auth.Authentication"]);
  });

  it("keeps the handler hop present and unresolved when no symbol was found", () => {
    // The step must not vanish: a flow that skips straight from route to table
    // implies a directness nobody observed.
    const { flows } = assembleFlows(
      input({
        routes: [route({ handlerSymbolId: null })],
        handlerGaps: new Map([["svc:POST /v2/leaves", "2 symbols named Creation match"]]),
      }),
    );

    const handler = flows[0]!.steps.find((step) => step.kind === "handler")!;
    expect(handler.label).toBe("leave.Creation");
    expect(handler.unresolvedReason).toBe("2 symbols named Creation match");
    expect(flows[0]!.partial).toBe(true);
  });

  it("says the data hop could not be followed when the handler is unknown", () => {
    const { flows } = assembleFlows(input({ routes: [route({ handlerSymbolId: null })] }));
    const data = flows[0]!.steps.find((step) => step.kind === "data-access")!;
    expect(data.unresolvedReason).toContain("handler was not resolved");
  });

  it("records an endpoint nobody was observed to call, rather than implying none exists", () => {
    const { flows } = assembleFlows(input({ links: [] }));
    const caller = flows[0]!.steps[0]!;
    expect(caller.unresolvedReason).toContain("outside the workspace");
  });

  it("does not reach into another package for data access", () => {
    const { flows } = assembleFlows(
      input({ dataAccess: [access("wcp_user", "read", "internal/handlers/user/service.go")] }),
    );

    const data = flows[0]!.steps.find((step) => step.kind === "data-access")!;
    expect(data.label).toBe("none observed");
    expect(data.unresolvedReason).toContain("handler's package");
  });

  it("skips a route naming no feature instead of forcing it under one", () => {
    const result = assembleFlows(input({ routes: [route({ path: "/v2/ping", method: "GET" })] }));
    expect(result.flows).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("no detected feature");
  });

  it("bounds the tables shown and says how many it left out", () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      access(`wcp_t${index}`, "read", "internal/handlers/leave/service.go"),
    );
    const { flows } = assembleFlows(input({ dataAccess: many }), { maxTables: 3 });

    const data = flows[0]!.steps.filter((step) => step.kind === "data-access");
    expect(data).toHaveLength(4);
    expect(data[3]!.label).toBe("12 more tables");
    expect(data[3]!.unresolvedReason).toContain("first 3");
  });
});

describe("flowToMermaid", () => {
  it("hangs every table off the handler rather than chaining them", () => {
    // Chaining would draw an order the code never states.
    const { flows } = assembleFlows(input());
    const diagram = flowToMermaid(flows[0]!);

    expect(diagram).toContain('s2 -->|"write"| s3');
    expect(diagram).toContain('s2 -->|"write"| s4');
    expect(diagram).not.toMatch(/\bs3 -->? *\|?[^\n]*s4/);
  });

  it("draws an unresolved step dashed, with its reason on the edge into it", () => {
    const { flows } = assembleFlows(input({ routes: [route({ handlerSymbolId: null })] }));
    const diagram = flowToMermaid(flows[0]!);

    expect(diagram).toContain("-.->");
    expect(diagram).toMatch(/-\.->\|"[^"]*not resolved/);
    expect(diagram).toContain("style s2 stroke-dasharray");
  });

  it("dashes a leading step that was never established, which has no edge into it", () => {
    const { flows } = assembleFlows(input({ links: [] }));
    const diagram = flowToMermaid(flows[0]!);

    expect(diagram).toContain("style s0 stroke-dasharray");
    expect(diagram).toContain("no caller observed");
  });

  it("keeps a label with Mermaid syntax in it from breaking the diagram", () => {
    const { flows } = assembleFlows(
      input({ routes: [route({ path: "/v2/leaves/{id}[x]" })], links: [] }),
    );
    const diagram = flowToMermaid(flows[0]!);

    expect(diagram).toContain("POST /v2/leaves/(id)(x)");
    expect(diagram).not.toMatch(/\["[^"]*\[/);
  });

  it("puts callers on one side and tables on the other in a feature overview", () => {
    const { flows } = assembleFlows(input());
    const diagram = featureOverviewMermaid("Leave", flows);

    expect(diagram).toContain("c_ui --> e0");
    expect(diagram).toContain("e0 --> t_wcp_leave");
  });

  it("says how many endpoints an overview left out", () => {
    const routes = Array.from({ length: 5 }, (_, index) =>
      route({ path: `/v2/leaves/${index}`, method: "GET" }),
    );
    const { flows } = assembleFlows(input({ routes }));
    const diagram = featureOverviewMermaid("Leave", flows, 2);

    expect(diagram).toContain("3 more endpoints");
  });
});

describe("detectFeatures", () => {
  const files = [
    { rootName: "svc", relPath: "internal/handlers/leave/router.go" },
    { rootName: "svc", relPath: "internal/handlers/leave/service.go" },
  ];

  it("names a feature after the domain term its tables and routes share", () => {
    const { features } = detectFeatures({
      entityNames: ["wcp_leave", "wcp_leave_detail"],
      routes: Array.from({ length: 6 }, (_, index) =>
        route({ path: `/v2/leaves/${index}`, method: "GET" }),
      ),
      files,
    });

    expect(features[0]!.name).toBe("Leave");
    expect(features[0]!.entities).toEqual(["wcp_leave", "wcp_leave_detail"]);
  });

  it("refuses a term that appears in only one kind of place", () => {
    // One table nobody else mentions is a table, not a feature.
    const { features } = detectFeatures({
      entityNames: ["wcp_orphan"],
      routes: [],
      files: [],
    });
    expect(features).toEqual([]);
  });

  it("sets aside a term with two signals but little behind it, and says so", () => {
    const detection = detectFeatures({
      entityNames: [],
      routes: [route({ path: "/v2/ping/status" })],
      files: [{ rootName: "svc", relPath: "internal/ping/handler.go" }],
    });

    expect(detection.features).toEqual([]);
    expect(detection.setAside.map((term) => term.term)).toContain("ping");
  });

  it("does not treat interface vocabulary as a product feature", () => {
    const uiFiles = Array.from({ length: 40 }, (_, index) => ({
      rootName: "ui",
      relPath: `src/components/modal/Modal${index}.tsx`,
    }));
    const { features } = detectFeatures({
      entityNames: [],
      routes: Array.from({ length: 10 }, () => route({ path: "/v2/modal" })),
      files: uiFiles,
    });

    expect(features.map((feature) => feature.term)).not.toContain("modal");
  });
});
