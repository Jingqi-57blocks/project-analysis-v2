import { describe, expect, it } from "vitest";

import { assembleReport, type AssembleReportInput } from "../../engine/report/model.js";

function input(overrides: Partial<AssembleReportInput> = {}): AssembleReportInput {
  return {
    runId: "run-20260728T120000Z-abc123",
    generatedAt: "2026-07-28T12:00:00.000Z",
    workspacePath: "/w",
    projectName: "Orders Platform",
    description: "Handles ordering and billing.",
    roots: [{ name: "api", language: "go", fileCount: 10, analyzed: 9, excluded: 1 }],
    features: [],
    mapDiagram: "flowchart LR\n  n_api[\"api\"]",
    unassignedEndpointCount: 0,
    screens: [],
    structuralFindings: [],
    modules: [
      {
        id: "mod_abc",
        name: "orders",
        entryKeys: ["api:GET /orders"],
        rootNames: ["api"],
        symbolIds: [],
        groupingSignal: "shared resource",
      },
    ],
    components: [
      { id: "cmp_1", name: "auth", rootName: "api", signals: ["folder containment"], memberPaths: ["auth/a.go"] },
    ],
    integrations: [{ from: "ui", to: "api", calls: 3 }],
    map: [{ from: "ui", to: "api", kind: "internal" as const, detail: "3 calls" }],
    dataEntities: ["orders", "users"],
    routesByModule: new Map([["mod_abc", [{ method: "GET", path: "/orders", rootName: "api" }]]]),
    dataByModule: new Map([["mod_abc", ["orders"]]]),
    outboundByModule: new Map([["mod_abc", ["https://payments.example.com/charge"]]]),
    signals: [
      {
        id: "root-cycles",
        title: "Services that call each other",
        finding: "No two roots were found calling each other.",
        severity: "info",
        evidence: [],
        value: 0,
      },
    ],
    dispositions: {
      behavioralSource: 5,
      technicalOnly: 2,
      sharedInfrastructure: 2,
      unclassified: 1,
      total: 10,
    },
    evidenceByModule: new Map([["mod_abc", ["Places an order for a customer."]]]),
    coverageNotes: [{ subject: "Routes", note: "Router group prefixes are not resolved." }],
    ...overrides,
  };
}

describe("the report model", () => {
  it("carries the run id, so separately generated reports can be tied together", () => {
    expect(assembleReport(input()).runId).toBe("run-20260728T120000Z-abc123");
  });

  it("attaches each module's evidence without paraphrasing it", () => {
    const model = assembleReport(input());
    expect(model.modules[0]!.evidence).toEqual(["Places an order for a customer."]);
  });

  it("filters health down to what deserves attention", () => {
    // A list nobody finishes reading is a list nobody acts on.
    expect(assembleReport(input()).attentionSignals).toEqual([]);

    const loud = assembleReport(
      input({
        signals: [
          { id: "x", title: "T", finding: "F", severity: "concern", evidence: ["e1"], value: 1 },
          { id: "y", title: "Y", finding: "G", severity: "info", evidence: [], value: 0 },
        ],
      }),
    );
    expect(loud.attentionSignals.map((signal) => signal.id)).toEqual(["x"]);
  });

  it("carries no wording of its own — only facts a document can be worded from", () => {
    // The model is the knowledge a template renders against. A sentence
    // composed here would be a claim nobody wrote and nobody can edit.
    const serialized = JSON.stringify(assembleReport(input()));
    expect(serialized).not.toContain("lets a caller");
    expect(serialized).not.toContain("was observed");
  });
});
