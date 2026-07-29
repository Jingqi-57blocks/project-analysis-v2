import { describe, expect, it } from "vitest";

import { assembleReport, type AssembleReportInput } from "../../engine/report/model.js";
import { renderHtmlReport, escapeHtml } from "../../engine/report/html.js";
import { stringsFor, supportedLanguages } from "../../engine/report/strings.js";

function input(overrides: Partial<AssembleReportInput> = {}): AssembleReportInput {
  return {
    runId: "run-20260728T120000Z-abc123",
    generatedAt: "2026-07-28T12:00:00.000Z",
    workspacePath: "/w",
    projectName: "Orders Platform",
    description: "Handles ordering and billing.",
    language: "en",
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

describe("escapeHtml", () => {
  it("escapes markup so project prose cannot inject it", () => {
    // Report content includes README text and comments — untrusted input.
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });
});

describe("the report model", () => {
  it("carries the run id, so separately generated reports can be tied together", () => {
    expect(assembleReport(input()).runId).toBe("run-20260728T120000Z-abc123");
  });

  it("attaches each module's evidence without paraphrasing it", () => {
    const model = assembleReport(input());
    expect(model.modules[0]!.evidence).toEqual(["Places an order for a customer."]);
  });
});

describe("rendering", () => {
  it("produces separate pages with working navigation between them", () => {
    const pages = renderHtmlReport(assembleReport(input()));
    expect(pages.map((p) => p.filename)).toEqual([
      "index.html",
      "capabilities.html",
      "features.html",
      "components.html",
    ]);

    for (const page of pages) {
      expect(page.html).toContain('href="index.html"');
      expect(page.html).toContain('href="capabilities.html"');
      expect(page.html).toContain('href="features.html"');
      expect(page.html).toContain('href="components.html"');
    }
  });

  it("opens from disk — no external stylesheet, script or font", () => {
    const html = renderHtmlReport(assembleReport(input()))[0]!.html;
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    expect(html).not.toContain("cdn");
  });

  it("shows the run id on every page, however a reader arrived at it", () => {
    for (const page of renderHtmlReport(assembleReport(input()))) {
      expect(page.html).toContain("run-20260728T120000Z-abc123");
    }
  });

  it("contains no source locators a PM would have to decode", () => {
    // The audience decides what belongs: no service.ts:113, no symbol ids.
    const html = renderHtmlReport(assembleReport(input())).map((p) => p.html).join("");
    expect(html).not.toMatch(/\.(ts|go|js|py):\d+/);
    expect(html).not.toContain("symbolId");
  });

  it("states what it could not tell you rather than leaving it out", () => {
    const html = renderHtmlReport(assembleReport(input()))[0]!.html;
    expect(html).toContain("Router group prefixes are not resolved.");
  });

  it("renders integrations as readable text with the diagram source available", () => {
    const html = renderHtmlReport(assembleReport(input()))[0]!.html;
    expect(html).toContain("graph LR");
    expect(html).toContain("ui");
    expect(html).toContain("api");
  });

  it("says so plainly when there are no integrations", () => {
    const html = renderHtmlReport(assembleReport(input({ map: [] })))[0]!.html;
    expect(html).toContain("No calls between parts");
  });

  it("shows the project map, a module list, and what each feature exposes", () => {
    const pages = renderHtmlReport(assembleReport(input()));
    const overview = pages.find((page) => page.filename === "index.html");
    const features = pages.find((page) => page.filename === "features.html");
    expect(overview!.html).toContain("How the system fits together");
    expect(overview!.html).toContain("orders");
    expect(features!.html).toContain("GET /orders");
    expect(features!.html).toContain("https://payments.example.com/charge");
  });

  it("filters health down to what deserves attention", () => {
    // A list nobody finishes reading is a list nobody acts on.
    const quiet = assembleReport(input());
    expect(quiet.attentionSignals).toEqual([]);
    expect(renderHtmlReport(quiet)[0]!.html).toContain("Nothing was found that needs attention");

    const loud = assembleReport(
      input({
        signals: [
          { id: "x", title: "T", finding: "F", severity: "concern", evidence: ["e1"], value: 1 },
          { id: "y", title: "Y", finding: "G", severity: "info", evidence: [], value: 0 },
        ],
      }),
    );
    expect(loud.attentionSignals.map((sig) => sig.id)).toEqual(["x"]);
    expect(renderHtmlReport(loud)[0]!.html).toContain("e1");
  });

  it("says the code carries no description rather than inventing one", () => {
    // A report that reads well and is partly invented is worse than one with
    // visible holes.
    const html = renderHtmlReport(
      assembleReport(input({ description: null, evidenceByModule: new Map() })),
    ).find((page) => page.filename === "features.html")!.html;
    expect(html).toContain("The code carries no description");
  });

  it("says so plainly when no features were formed", () => {
    const html = renderHtmlReport(assembleReport(input({ modules: [] }))).find(
      (page) => page.filename === "features.html",
    )!.html;
    expect(html).toContain("No features could be formed");
  });
});

describe("output language", () => {
  it("renders in Chinese when asked", () => {
    const pages = renderHtmlReport(assembleReport(input({ language: "zh" })));
    expect(pages[0]!.html).toContain('lang="zh"');
    expect(pages[0]!.html).toContain("总览");
    expect(pages[0]!.html).toContain("需要关注的地方");
  });

  it("keeps identifiers and evidence verbatim in every language", () => {
    // Translating a name would break the link between a report and the code it
    // describes, which is what makes a report checkable.
    const zh = renderHtmlReport(assembleReport(input({ language: "zh" })));
    const find = (filename: string): string =>
      zh.find((page) => page.filename === filename)!.html;
    expect(find("index.html")).toContain("run-20260728T120000Z-abc123");
    expect(find("features.html")).toContain("Places an order for a customer.");
    expect(find("components.html")).toContain("auth");
  });

  it("reports the same facts regardless of language", () => {
    // Language changes the wording; it never changes the finding.
    const en = assembleReport(input({ language: "en" }));
    const zh = assembleReport(input({ language: "zh" }));

    expect(zh.modules).toEqual(en.modules);
    expect(zh.signals).toEqual(en.signals);
    expect(zh.dispositions).toEqual(en.dispositions);
  });

  it("falls back to English and says so, rather than emitting a half-translated report", () => {
    const html = renderHtmlReport(assembleReport(input({ language: "de" })))[0]!.html;
    expect(html).toContain("Overview");
    // Quotes arrive HTML-escaped, which is correct — the message is content.
    expect(html).toContain("No wording is available for &quot;de&quot;");
  });

  it("lists the languages it actually has wording for", () => {
    expect(supportedLanguages()).toEqual(["en", "zh"]);
    expect(stringsFor("en").languageFallback).toBeNull();
  });
});
