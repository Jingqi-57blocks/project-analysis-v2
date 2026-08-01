import { describe, expect, it } from "vitest";

import { lineRef, type SourceRef } from "../../../engine/contracts/shared-fact/provenance.js";
import { SECTION_CATALOG } from "../../../engine/contracts/report/catalog.js";
import {
  ARCHITECTURE_NOTES_BLOCK,
  DETERMINISTIC_SCHEMA_BLOCKS,
  DEV_ARCHITECTURE_AUTHORED_BLOCKS,
  type CallEdgeRecord,
  type ContainmentRecord,
  type EntryRecord,
  type ModuleNode,
  type OpsEntry,
  type PackageDependencyRecord,
  type SymbolRecord,
  renderCallGraph,
  renderOps,
  renderSymbols,
  renderTopology,
  validateCallGraph,
  validateOps,
  validateSymbols,
  validateTopology,
} from "../../../engine/report/content/architecture.js";

const ROOT = "wcp-service-v2";
const cite = (path: string, line = 1): SourceRef => lineRef(ROOT, path, line);

const modules: ModuleNode[] = [
  { moduleId: "leave", name: "Leave", repository: "wcp-service-v2", citation: cite("internal/leave/mod.go") },
  { moduleId: "auth", name: "Auth", repository: "wcp-service-v2", citation: cite("internal/auth/mod.go") },
];
const containment: ContainmentRecord[] = [{ parentModuleId: "leave", childModuleId: "auth" }];
const deps: PackageDependencyRecord[] = [
  { fromModuleId: "leave", toModuleId: "auth" },
  { fromModuleId: "leave", toModuleId: "github.com/ext/lib" }, // external boundary
];

describe("renderTopology", () => {
  it("is deterministic, reconciles its count and surfaces boundary dependencies", () => {
    const t = renderTopology(modules, containment, deps);
    expect(t.moduleCount).toBe(2);
    expect(t.nodes.map((n) => n.moduleId)).toEqual(["auth", "leave"]);
    expect(t.nodes.find((n) => n.moduleId === "leave")!.dependsOn).toEqual(["auth"]);
    expect(t.boundaryDependencies).toContain("github.com/ext/lib"); // not invented as a node
    expect(t.nodes.some((n) => n.moduleId === "github.com/ext/lib")).toBe(false);
    expect(validateTopology(t, modules)).toEqual({ ok: true });
  });
});

const symbols: SymbolRecord[] = [
  { symbolId: "s:Approve", name: "Approve", relPath: "svc/handler.go", kind: "function", citation: cite("svc/handler.go", 10) },
  { symbolId: "s:Submit", name: "Submit", relPath: "svc/handler.go", kind: "function", citation: cite("svc/handler.go", 20) },
];
const entries: EntryRecord[] = [
  { symbolId: "s:Approve", precision: "exact", mechanism: "http-route", citation: cite("svc/handler.go", 10) },
  { symbolId: "s:Submit", precision: "candidate", mechanism: "naming-heuristic", citation: cite("svc/handler.go", 20) },
];

describe("renderSymbols", () => {
  it("counts symbols and entries by precision and indexes source files", () => {
    const set = renderSymbols(symbols, entries);
    expect(set.symbolCount).toBe(2);
    expect(set.byPrecision).toEqual({ exact: 1, candidate: 1 });
    expect(set.entries.map((e) => e.symbolId)).toEqual(["s:Approve", "s:Submit"]);
    expect(set.sourceFiles).toEqual(["svc/handler.go"]); // distinct source files
    expect(validateSymbols(set, symbols)).toEqual({ ok: true });
  });

  it("rejects a duplicate symbol id", () => {
    const dup = renderSymbols([symbols[0]!, { ...symbols[0]!, name: "Approve2" }], []);
    expect(validateSymbols(dup, [symbols[0]!, { ...symbols[0]!, name: "Approve2" }]).ok).toBe(false);
  });
});

const nodeIds = ["s:A", "s:B", "s:C"];
const edges: CallEdgeRecord[] = [
  { from: "s:A", to: "s:B", kind: "call", resolution: "resolved", dynamic: false, citation: cite("a.go", 1) },
  { from: "s:B", to: "s:C", kind: "call", resolution: "resolved", dynamic: false, citation: cite("b.go", 2) },
  { from: "s:C", to: "s:A", kind: "call", resolution: "resolved", dynamic: false, citation: cite("c.go", 3) }, // closes a cycle
  { from: "s:A", to: "s:ext", kind: "reference", resolution: "unresolved", dynamic: true, citation: cite("a.go", 4) }, // dynamic, boundary
];

describe("renderCallGraph", () => {
  it("counts by resolution and kind, marks boundaries and dynamic calls, flags truncation", () => {
    const g = renderCallGraph(nodeIds, edges, true, 12);
    expect(g.edgeCount).toBe(4);
    expect(g.byResolution).toEqual({ resolved: 3, heuristic: 0, unresolved: 1 });
    expect(g.dynamicCount).toBe(1);
    expect(g.boundaryTargets).toEqual(["s:ext"]); // s:ext is outside the node set
    expect(g.truncated).toBe(true);
    expect(g.omittedEdges).toBe(12); // the handle back to the full index
    expect(validateCallGraph(g, nodeIds)).toEqual({ ok: true });
  });

  it("counts all five edge kinds", () => {
    const mixed: CallEdgeRecord[] = (["call", "reference", "import", "type-relation", "instantiation"] as const).map((kind, i) => ({
      from: "s:A",
      to: "s:B",
      kind,
      resolution: "resolved" as const,
      dynamic: false,
      citation: cite("m.go", i + 1),
    }));
    const g = renderCallGraph(["s:A", "s:B"], mixed, false);
    expect(g.byKind).toEqual({ call: 1, reference: 1, import: 1, "type-relation": 1, instantiation: 1 });
    expect(g.edgeCount).toBe(5);
  });

  it("detects a cycle among resolved edges", () => {
    const g = renderCallGraph(nodeIds, edges, false);
    expect(g.cycles.length).toBe(1);
    expect(g.cycles[0]).toEqual(["s:A", "s:B", "s:C"]); // canonicalised to start at the smallest id
  });

  it("does not claim a cycle on heuristic or unresolved edges", () => {
    const heuristicCycle: CallEdgeRecord[] = [
      { from: "s:A", to: "s:B", kind: "call", resolution: "heuristic", dynamic: false, citation: cite("a.go", 1) },
      { from: "s:B", to: "s:A", kind: "call", resolution: "unresolved", dynamic: false, citation: cite("b.go", 2) },
    ];
    expect(renderCallGraph(["s:A", "s:B"], heuristicCycle, false).cycles).toHaveLength(0);
  });

  it("draws no phantom edge — an edge from an unknown node is rejected", () => {
    const phantom = renderCallGraph(["s:A"], [{ from: "s:ghost", to: "s:A", kind: "call", resolution: "resolved", dynamic: false, citation: cite("x.go", 1) }], false);
    expect(validateCallGraph(phantom, ["s:A"]).ok).toBe(false);
  });
});

describe("renderOps — three-state, never a takeover manual", () => {
  const ops: OpsEntry[] = [
    { kind: "build", name: "Makefile", state: "present", reason: "", citation: cite("Makefile", 1) },
    { kind: "deploy", name: "production", state: "unknown", reason: "no deploy descriptor found in the repository", citation: null },
  ];

  it("counts by kind and validates present-needs-citation, unknown-needs-reason", () => {
    const report = renderOps(ops);
    expect(report.byKind.build).toBe(1);
    expect(report.byKind.deploy).toBe(1);
    expect(validateOps(report)).toEqual({ ok: true });
  });

  it("rejects a present entry with no citation", () => {
    const bad = renderOps([{ kind: "build", name: "x", state: "present", reason: "", citation: null }]);
    expect(validateOps(bad).ok).toBe(false);
  });
});

describe("renderTopology — duplicate module", () => {
  it("rejects a duplicated module id in the topology", () => {
    const dup: ModuleNode = { moduleId: "leave", name: "Leave dup", repository: "r", citation: cite("b.go") };
    const t = renderTopology([...modules, dup], [], []);
    expect(validateTopology(t, [...modules, dup]).ok).toBe(false);
  });
});

describe("blocks agree with the section catalog", () => {
  const catalogBlocks = new Map(SECTION_CATALOG.flatMap((s) => s.blocks).map((b) => [b.id, b.outputSchemaId]));

  it("the architecture-notes authored block matches its catalog block", () => {
    for (const block of DEV_ARCHITECTURE_AUTHORED_BLOCKS) {
      expect(catalogBlocks.get(block.blockId)).toBe(block.outputSchemaId);
      expect(block.citationRule).toBe("required");
    }
    expect(ARCHITECTURE_NOTES_BLOCK.blockId).toBe("project-architecture.boundaries");
  });

  it("every deterministic renderer schema matches its catalog block", () => {
    for (const { blockId, outputSchemaId } of DETERMINISTIC_SCHEMA_BLOCKS) {
      expect(catalogBlocks.get(blockId), blockId).toBe(outputSchemaId);
    }
  });
});
