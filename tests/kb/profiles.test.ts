import { describe, expect, it } from "vitest";

import {
  flowCoverage,
  repositoryProfiles,
  STACK_LIMIT,
  type ProfileInput,
} from "../../engine/kb/profiles.js";
import type { FeatureFlowFact, RootSummaryFact } from "../../engine/kb/facts.js";
import type { PackageDependencyRecord } from "../../engine/structural/dependencies.js";
import type { ImportRecord, SourceFileRecord } from "../../engine/structural/code.js";
import type { RouteRecord } from "../../engine/structural/boundaries.js";
import { declared, fileRef, lineRef } from "../../engine/structural/provenance.js";

function root(name: string, overrides: Partial<RootSummaryFact> = {}): RootSummaryFact {
  return { name, language: "go", analyzed: 10, excluded: 1, ...overrides };
}

function file(rootName: string, relPath: string, language: string | null): SourceFileRecord {
  return { rootName, relPath, language, provenance: declared(lineRef(rootName, relPath, 1)) };
}

function dependency(
  rootName: string,
  name: string,
  overrides: Partial<PackageDependencyRecord> = {},
): PackageDependencyRecord {
  return {
    rootName,
    ecosystem: "npm",
    name,
    versionConstraint: "^1.0.0",
    resolvedVersion: null,
    scope: "runtime",
    directness: "direct",
    declaredIn: fileRef(rootName, "package.json"),
    provenance: declared(fileRef(rootName, "package.json")),
    ...overrides,
  };
}

function importOf(rootName: string, specifier: string, relPath = "src/a.ts"): ImportRecord {
  return {
    rootName,
    relPath,
    specifier,
    resolvedPath: null,
    importedNames: [],
    isTypeOnly: false,
    provenance: declared(lineRef(rootName, relPath, 1)),
  };
}

function route(rootName: string, path: string, surface: "server" | "client" = "server"): RouteRecord {
  return {
    rootName,
    method: surface === "server" ? "POST" : null,
    path,
    handlerSymbolId: null,
    handlerName: null,
    handlerCandidates: [],
    middleware: [],
    surface,
    provenance: declared(lineRef(rootName, "router.go", 1)),
  };
}

function flow(overrides: Partial<FeatureFlowFact> = {}): FeatureFlowFact {
  return {
    featureId: "feat_leave",
    featureName: "Leave",
    entryKey: "svc:POST /v2/leaves",
    method: "POST",
    path: "/v2/leaves",
    steps: [],
    partial: false,
    diagram: "",
    ...overrides,
  };
}

function step(unresolvedReason: string | null, truncated = false) {
  return {
    kind: "handler" as const,
    label: "Apply",
    rootName: "svc",
    conditions: [],
    unresolvedReason,
    truncated,
    provenance: null,
  };
}

function input(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    roots: [root("svc")],
    fileFacts: [
      { rootName: "svc", codeFiles: 8, filesWithFacts: 6, migrationFiles: 3, migrationsWithFacts: 1 },
    ],
    sourceFiles: [],
    endpoints: [],
    screens: [],
    entities: [],
    tests: [],
    dependencies: [],
    imports: [],
    flows: [],
    completedTraces: [],
    scheduledRoots: [],
    notifyingRoots: [],
    dataAccessRoots: [],
    ...overrides,
  };
}

describe("what a repository is", () => {
  it("names the languages by how much of the repository is written in each", () => {
    const profile = repositoryProfiles(
      input({
        sourceFiles: [
          file("svc", "a.go", "go"),
          file("svc", "b.go", "go"),
          file("svc", "c.yaml", "yaml"),
          file("svc", "d.bin", null),
        ],
      }),
    )[0]!;

    expect(profile.languages).toEqual([
      { name: "go", files: 2 },
      { name: "yaml", files: 1 },
    ]);
  });

  it("says what the repository does, as tokens a report words in its own language", () => {
    const profile = repositoryProfiles(
      input({
        endpoints: [route("svc", "/v2/leaves")],
        dataAccessRoots: ["svc"],
        scheduledRoots: ["svc"],
      }),
    )[0]!;

    expect(profile.roles).toEqual(["serves-http", "stores-data", "runs-scheduled"]);
  });

  it("leaves the roles empty rather than inventing one for a repository with no entry points", () => {
    expect(repositoryProfiles(input())[0]!.roles).toEqual([]);
  });

  it("counts endpoints as traced from the walk through the code, not from a flow", () => {
    // A flow's first step is the caller, so an endpoint nothing in the
    // workspace calls used to count as untraced however completely its handler
    // was followed — and an endpoint in no capability has no flow at all.
    // Measured on wcp-service: 21 of 90 reported where 82 walks completed.
    const profile = repositoryProfiles(
      input({
        endpoints: [
          route("svc", "/v2/leaves"),
          route("svc", "/v2/holidays"),
          route("svc", "/v2/orphan"),
        ],
        // No flow for the orphan: it belongs to no capability.
        flows: [flow({ entryKey: "svc:POST /v2/leaves", partial: true })],
        completedTraces: [
          { entryKey: "svc:POST /v2/leaves", partial: false },
          { entryKey: "svc:POST /v2/holidays", partial: true },
          { entryKey: "svc:POST /v2/orphan", partial: false },
        ],
      }),
    )[0]!;

    expect(profile.endpointCount).toBe(3);
    // Leave's flow is partial for want of a caller; its own walk completed.
    expect(profile.tracedEndpointCount).toBe(2);
  });

  it("carries the file counts the file table answered", () => {
    const profile = repositoryProfiles(input())[0]!;
    expect([profile.analyzedFiles, profile.excludedFiles]).toEqual([10, 1]);
    expect([profile.codeFiles, profile.filesWithFacts]).toEqual([8, 6]);
  });

  it("keeps migration scripts out of the code coverage fraction", () => {
    // WCP's older service holds 290 migrations against 121 source files.
    // Folded together its coverage read as 63% when 81% of its code had been
    // read — a denominator that misleads is worse than two numbers.
    const profile = repositoryProfiles(input())[0]!;
    expect([profile.codeFiles, profile.filesWithFacts]).toEqual([8, 6]);
    expect([profile.migrationFiles, profile.migrationsWithFacts]).toEqual([3, 1]);
  });

  it("reports no coverage rather than a wrong one for a root the file table missed", () => {
    const profile = repositoryProfiles(input({ fileFacts: [] }))[0]!;
    expect([profile.codeFiles, profile.filesWithFacts]).toEqual([0, 0]);
    expect([profile.migrationFiles, profile.migrationsWithFacts]).toEqual([0, 0]);
  });
});

describe("the stack of a repository", () => {
  it("ranks packages by how many of its own files import them", () => {
    const profile = repositoryProfiles(
      input({
        dependencies: [dependency("svc", "react"), dependency("svc", "yup")],
        imports: [
          importOf("svc", "react"),
          importOf("svc", "react", "src/b.ts"),
          importOf("svc", "yup"),
        ],
      }),
    )[0]!;

    expect(profile.stack.map((entry) => [entry.name, entry.importedBy])).toEqual([
      ["react", 2],
      ["yup", 1],
    ]);
  });

  it("counts each repository's own imports, never the workspace's", () => {
    // One service declaring gorm was shown the whole workspace's gorm count,
    // which put packages at the top of a stack that the repository never
    // imports at all.
    const profiles = repositoryProfiles(
      input({
        roots: [root("svc"), root("ui")],
        fileFacts: [],
        dependencies: [dependency("svc", "gorm"), dependency("ui", "gorm")],
        imports: [importOf("svc", "gorm"), importOf("svc", "gorm", "b.go")],
      }),
    );

    expect(profiles[0]!.stack[0]!.importedBy).toBe(2);
    expect(profiles[1]!.stack[0]!.importedBy).toBe(0);
  });

  it("credits a Go module for the packages imported below it", () => {
    const profile = repositoryProfiles(
      input({
        dependencies: [dependency("svc", "github.com/gin-gonic/gin", { ecosystem: "go" })],
        imports: [importOf("svc", "github.com/gin-gonic/gin/binding")],
      }),
    )[0]!;

    expect(profile.stack[0]!.importedBy).toBe(1);
  });

  it("keeps a package named after the repository's language, which nothing imports", () => {
    // TypeScript is the stack of a TypeScript project and is imported by no
    // file in it; ranking on imports alone dropped it off the list.
    const profile = repositoryProfiles(
      input({
        sourceFiles: [file("ui", "a.ts", "typescript")],
        roots: [root("ui")],
        dependencies: [
          dependency("ui", "typescript", { scope: "development" }),
          ...Array.from({ length: STACK_LIMIT + 4 }, (_, n) => dependency("ui", `pkg-${n}`)),
        ],
        imports: Array.from({ length: STACK_LIMIT + 4 }, (_, n) =>
          importOf("ui", `pkg-${n}`, `src/${n}.ts`),
        ),
      }),
    )[0]!;

    expect(profile.stack[0]!.name).toBe("typescript");
    expect(profile.stack).toHaveLength(STACK_LIMIT);
  });

  it("shows an exact version as resolved and a range as not", () => {
    const profile = repositoryProfiles(
      input({
        dependencies: [
          dependency("svc", "react", { resolvedVersion: "18.3.1" }),
          dependency("svc", "yup", { versionConstraint: "^1.7.1" }),
        ],
      }),
    )[0]!;

    expect(profile.stack.map((entry) => [entry.version, entry.resolved])).toEqual([
      ["18.3.1", true],
      ["^1.7.1", false],
    ]);
    expect([profile.directDependencies, profile.dependenciesWithExactVersion]).toEqual([2, 1]);
  });

  it("keeps the runtime apart from the packages, and out of the dependency count", () => {
    const profile = repositoryProfiles(
      input({
        dependencies: [
          dependency("svc", "node", { scope: "platform", versionConstraint: ">=20" }),
          dependency("svc", "react"),
        ],
      }),
    )[0]!;

    expect(profile.platforms.map((entry) => [entry.name, entry.version])).toEqual([["node", ">=20"]]);
    expect(profile.stack.map((entry) => entry.name)).toEqual(["react"]);
    expect(profile.directDependencies).toBe(1);
  });

  it("leaves a transitive dependency out of the stack", () => {
    const profile = repositoryProfiles(
      input({
        dependencies: [dependency("svc", "debug", { directness: "transitive" })],
      }),
    )[0]!;

    expect(profile.stack).toEqual([]);
  });
});

describe("how much of a flow was followed", () => {
  it("counts resolved steps against every step of the flow", () => {
    const coverage = flowCoverage([
      flow({ steps: [step(null), step(null), step("no handler could be resolved")] }),
    ])[0]!;

    expect([coverage.resolvedSteps, coverage.steps]).toEqual([2, 3]);
    expect(coverage.flows[0]!.unresolvedReasons).toEqual(["no handler could be resolved"]);
  });

  it("does not count a truncated step as unresolved, reason or no reason", () => {
    // The tool knew what was there and showed less of it, which is not the
    // same as not having established it. A truncated step carries a reason of
    // its own — "only the first 12 tables are shown" — so testing only the
    // reason-free case let a complete trace read as 94% followed, with a
    // reason column claiming it stopped where it had not.
    const silent = flowCoverage([flow({ steps: [step(null), step(null, true)] })])[0]!;
    expect([silent.resolvedSteps, silent.steps]).toEqual([2, 2]);

    const withReason = flowCoverage([
      flow({ steps: [step(null), step("only the first 12 tables are shown", true)] }),
    ])[0]!;
    expect([withReason.resolvedSteps, withReason.steps]).toEqual([2, 2]);
    expect(withReason.fullyTracedFlows).toBe(1);
    // And it is not offered to a reader as a place the trace stopped.
    expect(withReason.flows[0]!.unresolvedReasons).toEqual([]);
  });

  it("states each reason once, however many steps stopped for it", () => {
    const coverage = flowCoverage([
      flow({ steps: [step("nothing calls this endpoint"), step("nothing calls this endpoint")] }),
    ])[0]!;

    expect(coverage.flows[0]!.unresolvedReasons).toEqual(["nothing calls this endpoint"]);
  });

  it("groups by capability and puts the least-traced flow first", () => {
    const coverage = flowCoverage([
      flow({ entryKey: "svc:POST /a", path: "/a", steps: [step(null), step(null)] }),
      flow({ entryKey: "svc:GET /b", path: "/b", steps: [step(null), step("stopped")] }),
      flow({ featureId: "feat_holiday", featureName: "Holiday", entryKey: "svc:GET /c", path: "/c", steps: [step(null)] }),
    ]);

    expect(coverage.map((entry) => entry.featureName)).toEqual(["Leave", "Holiday"]);
    expect(coverage[0]!.flows.map((entry) => entry.path)).toEqual(["/b", "/a"]);
    expect([coverage[0]!.fullyTracedFlows, coverage[0]!.flowCount]).toEqual([1, 2]);
  });

  it("has nothing to say about a capability with no flows", () => {
    expect(flowCoverage([])).toEqual([]);
  });
});

describe("ordering a stack when there is no import evidence", () => {
  it("puts what the product runs on before what its authors build it with", () => {
    // A repository whose imports no reader could extract used to rank its
    // stack alphabetically, so a list of eslint plugins described the
    // toolchain rather than the product.
    const profile = repositoryProfiles(
      input({
        dependencies: [
          dependency("svc", "eslint", { scope: "development" }),
          dependency("svc", "zod"),
        ],
        imports: [],
      }),
    )[0]!;

    expect(profile.stack.map((entry) => entry.name)).toEqual(["zod", "eslint"]);
  });
});
