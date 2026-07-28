import { describe, expect, it } from "vitest";

import { buildCoverageMatrix, renderCoverageMatrix, type ProviderReport } from "../../engine/structural/coverage.js";
import { emptyRecords } from "../../engine/structural/kinds.js";
import { declared, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";
import { ANY_LANGUAGE } from "../../engine/structural/provider.js";
import { deriveTestRelations, isTestPath } from "../../engine/providers/tests/provider.js";
import type { SymbolRecord } from "../../engine/structural/code.js";

function symbol(name: string, relPath: string): SymbolRecord {
  return {
    id: symbolId({ rootName: "svc", relPath, kind: "function", qualifiedName: name, signature: null }),
    name,
    qualifiedName: name,
    kind: "function",
    visibility: "unknown",
    signature: null,
    containerId: null,
    provenance: declared(lineRef("svc", relPath, 10, 20)),
  };
}

function report(overrides: Partial<ProviderReport> = {}): ProviderReport {
  return {
    providerId: "p",
    capabilities: { declarations: [] },
    contribution: {
      providerId: "p",
      providerVersion: "1",
      rootName: "svc",
      records: emptyRecords(),
      gaps: [],
      failures: [],
    },
    ...overrides,
  };
}

describe("buildCoverageMatrix", () => {
  it("records a provider's declared support alongside what it produced", () => {
    const matrix = buildCoverageMatrix([
      report({
        capabilities: {
          declarations: [{ kind: "symbol", language: ANY_LANGUAGE, support: "full", limits: [] }],
        },
        contribution: {
          ...report().contribution,
          records: { ...emptyRecords(), symbol: [symbol("A", "a.go")] },
        },
      }),
    ]);

    const symbols = matrix.kinds.find((k) => k.kind === "symbol")!;
    expect(symbols.cells[0]).toMatchObject({ level: "full", recordCount: 1 });
    expect(symbols.covered).toBe(true);
  });

  it("carries declared limits into the matrix rather than losing them", () => {
    const matrix = buildCoverageMatrix([
      report({
        capabilities: {
          declarations: [
            { kind: "route", language: "go", support: "partial", limits: ["group prefixes unresolved"] },
          ],
        },
      }),
    ]);

    expect(matrix.kinds.find((k) => k.kind === "route")!.cells[0]!.limits).toEqual([
      "group prefixes unresolved",
    ]);
  });

  it("lists a kind no provider addressed as unclaimed", () => {
    // Defined by the model, addressed by nobody — a place a provider could go.
    const matrix = buildCoverageMatrix([report()]);
    expect(matrix.unclaimedKinds).toContain("symbol");
  });

  it("distinguishes a declared none from silence", () => {
    const matrix = buildCoverageMatrix([
      report({
        capabilities: {
          declarations: [{ kind: "route", language: ANY_LANGUAGE, support: "none", limits: [] }],
        },
      }),
    ]);

    expect(matrix.kinds.find((k) => k.kind === "route")!.cells[0]!.level).toBe("absent");
    expect(matrix.unclaimedKinds).not.toContain("route");
  });

  it("records a reported gap even when the provider declared nothing", () => {
    const matrix = buildCoverageMatrix([
      report({
        contribution: {
          ...report().contribution,
          gaps: [{ kind: "data-access", language: "go", reason: "no ORM knowledge" }],
        },
      }),
    ]);

    expect(matrix.kinds.find((k) => k.kind === "data-access")!.cells[0]!.gapReason).toBe(
      "no ORM knowledge",
    );
  });

  it("flags an empty universal kind as suspicious but not an empty conditional one", () => {
    // A codebase with files but no symbols means something failed to parse; a
    // library with no routes is simply a library.
    const matrix = buildCoverageMatrix([report()]);

    expect(matrix.kinds.find((k) => k.kind === "symbol")!.emptyIsSuspicious).toBe(true);
    expect(matrix.kinds.find((k) => k.kind === "route")!.emptyIsSuspicious).toBe(false);
  });

  it("is not fooled by a full claim that produced nothing", () => {
    const matrix = buildCoverageMatrix([
      report({
        capabilities: {
          declarations: [{ kind: "symbol", language: ANY_LANGUAGE, support: "full", limits: [] }],
        },
      }),
    ]);

    expect(matrix.kinds.find((k) => k.kind === "symbol")!.covered).toBe(false);
  });
});

describe("renderCoverageMatrix", () => {
  it("renders every kind, including unclaimed ones", () => {
    const rendered = renderCoverageMatrix(buildCoverageMatrix([report()]));
    expect(rendered).toContain("| Kind | Provider | Language | Support | Records | Notes |");
    expect(rendered).toContain("unclaimed");
  });

  it("calls out empty universal kinds as worth questioning", () => {
    const rendered = renderCoverageMatrix(buildCoverageMatrix([report()]));
    expect(rendered).toContain("Empty results worth questioning");
    expect(rendered).toContain("`symbol`");
  });

  it("says it is generated, so nobody maintains it by hand", () => {
    expect(renderCoverageMatrix(buildCoverageMatrix([report()]))).toContain("Do not edit by hand");
  });
});

describe("test relations", () => {
  it("recognizes conventional test paths across languages", () => {
    for (const path of [
      "internal/user_test.go",
      "src/__tests__/a.ts",
      "tests/test_thing.py",
      "src/a.spec.ts",
      "src/main/UserTests.java",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it("does not treat production code as a test", () => {
    for (const path of ["internal/user.go", "src/latest.ts", "src/contest.js"]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it("relates a test to the production symbol it calls", () => {
    const test = symbol("TestCreate", "user_test.go");
    const target = symbol("Create", "user.go");

    const relations = deriveTestRelations("svc", {
      symbols: [test, target],
      callEdges: [
        {
          callerId: test.id,
          calleeId: target.id,
          calleeName: "Create",
          provenance: declared(lineRef("svc", "user_test.go", 12)),
        },
      ],
    });

    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ targetName: "Create", relation: "covers" });
  });

  it("ignores a test calling another test, which is a helper not coverage", () => {
    const test = symbol("TestA", "a_test.go");
    const helper = symbol("setupB", "b_test.go");

    const relations = deriveTestRelations("svc", {
      symbols: [test, helper],
      callEdges: [
        {
          callerId: test.id,
          calleeId: helper.id,
          calleeName: "setupB",
          provenance: declared(lineRef("svc", "a_test.go", 5)),
        },
      ],
    });

    expect(relations.filter((r) => r.relation === "covers")).toEqual([]);
  });

  it("records an untraceable test rather than dropping it", () => {
    // An untraceable test is a finding about the codebase; omitting it would
    // make coverage look better than it is.
    const test = symbol("TestOrphan", "orphan_test.go");

    const relations = deriveTestRelations("svc", { symbols: [test], callEdges: [] });

    expect(relations).toHaveLength(1);
    expect(relations[0]!.targetSymbolId).toBeNull();
    expect(relations[0]!.provenance.resolutionClass).toBe("unresolved");
  });

  it("keeps an unresolved callee as a relation with a reason", () => {
    const test = symbol("TestX", "x_test.go");

    const relations = deriveTestRelations("svc", {
      symbols: [test],
      callEdges: [
        {
          callerId: test.id,
          calleeId: null,
          calleeName: "SomethingExternal",
          provenance: declared(lineRef("svc", "x_test.go", 9)),
        },
      ],
    });

    expect(relations[0]).toMatchObject({ targetName: "SomethingExternal", targetSymbolId: null });
    expect(relations[0]!.provenance.resolutionClass).toBe("unresolved");
  });

  it("produces nothing for a project with no test files", () => {
    expect(deriveTestRelations("svc", { symbols: [symbol("A", "a.go")], callEdges: [] })).toEqual([]);
  });
});

describe("gaps across languages", () => {
  it("shows every language's gap for a kind, not just the first", () => {
    // A polyglot repo can report an unreadable Podfile and an unreadable
    // build.gradle; matching on kind alone would drop the second.
    const matrix = buildCoverageMatrix([
      report({
        contribution: {
          ...report().contribution,
          gaps: [
            { kind: "package-dependency", language: "cocoapods", reason: "Podfile unreadable" },
            { kind: "package-dependency", language: "gradle", reason: "build.gradle unreadable" },
          ],
        },
      }),
    ]);

    const cells = matrix.kinds.find((k) => k.kind === "package-dependency")!.cells;
    expect(cells.map((c) => c.language).sort()).toEqual(["cocoapods", "gradle"]);
    expect(cells.map((c) => c.gapReason).sort()).toEqual([
      "Podfile unreadable",
      "build.gradle unreadable",
    ]);
  });

  it("matches a gap to the declaration of the same language", () => {
    const matrix = buildCoverageMatrix([
      report({
        capabilities: {
          declarations: [
            { kind: "route", language: "go", support: "partial", limits: [] },
            { kind: "route", language: "swift", support: "partial", limits: [] },
          ],
        },
        contribution: {
          ...report().contribution,
          gaps: [{ kind: "route", language: "swift", reason: "no Swift framework knowledge" }],
        },
      }),
    ]);

    const cells = matrix.kinds.find((k) => k.kind === "route")!.cells;
    expect(cells.find((c) => c.language === "go")!.gapReason).toBeNull();
    expect(cells.find((c) => c.language === "swift")!.gapReason).toBe("no Swift framework knowledge");
  });
});
