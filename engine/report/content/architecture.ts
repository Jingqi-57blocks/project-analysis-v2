/**
 * The developer report's architecture, modules, entry points and call paths.
 *
 * This renders the code graph a developer needs to locate implementation and
 * trace impact: the repository/module topology, the key symbols and entry
 * candidates, and the call/reference/import/type/instantiation edges between
 * them. Every node and edge keeps its real name, its source-location citation and
 * its code-derived identity (the module id, symbol id, or edge endpoints) — the
 * fact id a reader resolves it by.
 * Edges keep their resolution (resolved / heuristic / unresolved), dynamic calls
 * and third-party boundaries are marked, cycles are surfaced, and a truncated
 * traversal says so — so a graph is never mistaken for a complete or a clean one.
 * No edge is drawn that is not in the model.
 *
 * Pure — facts in, structured content out. Nothing re-scans source, invents an
 * edge, or infers production reality (version, traffic, incidents) from config.
 */

import type { FactKind } from "../../contracts/shared-fact/families.js";
import type { SourceRef } from "../../contracts/shared-fact/provenance.js";

/** Output schemas of the deterministic blocks these renderers satisfy (from the catalog). */
export const ARCHITECTURE_SCHEMA = "architecture.v1";
export const CALLPATHS_SCHEMA = "callpaths.v1";
export const MODULE_CALLPATHS_SCHEMA = "module-callpaths.v1";
export const SYMBOLS_SCHEMA = "module-symbols.v1";
export const OPS_SCHEMA = "ops.v1";

/** The deterministic renderer → catalog block-id bindings, so they can be verified against the catalog. */
export const DETERMINISTIC_SCHEMA_BLOCKS: readonly { readonly blockId: string; readonly outputSchemaId: string }[] = [
  { blockId: "project-architecture.map", outputSchemaId: ARCHITECTURE_SCHEMA },
  { blockId: "project-callpaths.graph", outputSchemaId: CALLPATHS_SCHEMA },
  { blockId: "module-callpaths-deps.graph", outputSchemaId: MODULE_CALLPATHS_SCHEMA },
  { blockId: "module-code-boundary.symbols", outputSchemaId: SYMBOLS_SCHEMA },
  { blockId: "project-ops-entrypoints.facts", outputSchemaId: OPS_SCHEMA },
];

const sortStrings = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

function hasCitation(ref: SourceRef): boolean {
  return ref.rootName.length > 0 && ref.relPath.length > 0;
}

// ---------------------------------------------------------------------------
// Topology — repositories, modules, containment and package dependencies.
// ---------------------------------------------------------------------------

export interface ModuleNode {
  readonly moduleId: string;
  readonly name: string;
  readonly repository: string;
  readonly citation: SourceRef;
}

export interface PackageDependencyRecord {
  readonly fromModuleId: string;
  readonly toModuleId: string;
}

export interface ContainmentRecord {
  readonly parentModuleId: string;
  readonly childModuleId: string;
}

export interface TopologyNode {
  readonly moduleId: string;
  readonly name: string;
  readonly repository: string;
  readonly children: readonly string[];
  readonly dependsOn: readonly string[];
  readonly citation: SourceRef;
}

export interface Topology {
  readonly nodes: readonly TopologyNode[];
  readonly repositories: readonly string[];
  readonly moduleCount: number;
  /** Dependencies to a module not in the input — a boundary, surfaced not dropped. */
  readonly boundaryDependencies: readonly string[];
}

export function renderTopology(
  modules: readonly ModuleNode[],
  containment: readonly ContainmentRecord[],
  dependencies: readonly PackageDependencyRecord[],
): Topology {
  const known = new Set(modules.map((m) => m.moduleId));
  const boundary = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  for (const c of containment) {
    if (known.has(c.parentModuleId) && known.has(c.childModuleId)) {
      (childrenOf.get(c.parentModuleId) ?? childrenOf.set(c.parentModuleId, []).get(c.parentModuleId)!).push(c.childModuleId);
    }
  }
  const dependsOf = new Map<string, string[]>();
  for (const d of dependencies) {
    if (!known.has(d.toModuleId)) boundary.add(d.toModuleId);
    // dependsOn lists internal dependencies only; a dependency on a module outside
    // the input is a boundary, surfaced separately rather than drawn as a node.
    if (known.has(d.fromModuleId) && known.has(d.toModuleId) && d.fromModuleId !== d.toModuleId) {
      (dependsOf.get(d.fromModuleId) ?? dependsOf.set(d.fromModuleId, []).get(d.fromModuleId)!).push(d.toModuleId);
    }
  }

  const nodes = [...modules]
    .sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0))
    .map((m) => ({
      moduleId: m.moduleId,
      name: m.name,
      repository: m.repository,
      children: sortStrings(childrenOf.get(m.moduleId) ?? []),
      dependsOn: sortStrings(dependsOf.get(m.moduleId) ?? []),
      citation: m.citation,
    }));

  return {
    nodes,
    repositories: sortStrings(modules.map((m) => m.repository)),
    moduleCount: modules.length,
    boundaryDependencies: sortStrings(boundary),
  };
}

// ---------------------------------------------------------------------------
// Symbols and entry points.
// ---------------------------------------------------------------------------

export type EntryPrecision = "exact" | "candidate";

export interface SymbolRecord {
  readonly symbolId: string;
  readonly name: string;
  readonly relPath: string;
  readonly kind: string;
  readonly citation: SourceRef;
}

export interface EntryRecord {
  readonly symbolId: string;
  readonly precision: EntryPrecision;
  readonly mechanism: string;
  readonly citation: SourceRef;
}

export interface SymbolSet {
  readonly symbols: readonly SymbolRecord[];
  readonly entries: readonly EntryRecord[];
  readonly symbolCount: number;
  /** The distinct source files the symbols live in — the file index. */
  readonly sourceFiles: readonly string[];
  readonly byPrecision: Readonly<Record<EntryPrecision, number>>;
}

export function renderSymbols(symbols: readonly SymbolRecord[], entries: readonly EntryRecord[]): SymbolSet {
  const sortedSymbols = [...symbols].sort((a, b) => (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0));
  // A symbol can be an entry via more than one mechanism, so sort by the full
  // tuple, not the symbol id alone.
  const entryKey = (e: EntryRecord): string =>
    `${e.symbolId}\0${e.mechanism}\0${e.precision}\0${e.citation.relPath}\0${e.citation.startLine ?? -1}\0${e.citation.startColumn ?? -1}`;
  const sortedEntries = [...entries].sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0));
  const byPrecision: Record<EntryPrecision, number> = { exact: 0, candidate: 0 };
  for (const e of sortedEntries) byPrecision[e.precision] += 1;
  const sourceFiles = sortStrings(symbols.map((s) => s.relPath));
  return { symbols: sortedSymbols, entries: sortedEntries, symbolCount: symbols.length, sourceFiles, byPrecision };
}

// ---------------------------------------------------------------------------
// Call graph — edges with resolution, cycles, boundaries and truncation.
// ---------------------------------------------------------------------------

export type EdgeKind = "call" | "reference" | "import" | "type-relation" | "instantiation";
export type EdgeResolution = "resolved" | "heuristic" | "unresolved";

export interface CallEdgeRecord {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly resolution: EdgeResolution;
  /** A dynamic/reflective call — marked, not silently treated as a static edge. */
  readonly dynamic: boolean;
  readonly citation: SourceRef;
}

export interface CallGraph {
  readonly edges: readonly CallEdgeRecord[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly byResolution: Readonly<Record<EdgeResolution, number>>;
  readonly byKind: Readonly<Record<EdgeKind, number>>;
  /** Cycles among resolved edges, each a list of node ids in order. */
  readonly cycles: readonly (readonly string[])[];
  /** Edge targets not in the node set — third-party / out-of-scope boundaries, marked. */
  readonly boundaryTargets: readonly string[];
  readonly dynamicCount: number;
  /** True when the traversal was cut off — the graph is partial, and says so. */
  readonly truncated: boolean;
  /** How many edges were omitted by truncation — the handle back to the full index. */
  readonly omittedEdges: number;
}

const EDGE_KINDS: readonly EdgeKind[] = ["call", "reference", "import", "type-relation", "instantiation"];
const EDGE_RESOLUTIONS: readonly EdgeResolution[] = ["resolved", "heuristic", "unresolved"];

/**
 * The call graph over the given nodes and edges. Every edge is one the model
 * holds — nothing is invented. Edge targets outside the node set are surfaced as
 * boundary targets (third-party or out-of-scope), not drawn as phantom nodes.
 * Cycles among resolved edges are detected and surfaced; a truncated traversal is
 * flagged so the graph is read as partial.
 */
export function renderCallGraph(
  nodeIds: readonly string[],
  edges: readonly CallEdgeRecord[],
  truncated: boolean,
  omittedEdges = 0,
): CallGraph {
  const nodes = new Set(nodeIds);
  const sorted = [...edges].sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0));

  const byResolution: Record<EdgeResolution, number> = { resolved: 0, heuristic: 0, unresolved: 0 };
  const byKind: Record<EdgeKind, number> = { call: 0, reference: 0, import: 0, "type-relation": 0, instantiation: 0 };
  const boundary = new Set<string>();
  let dynamicCount = 0;
  for (const e of sorted) {
    byResolution[e.resolution] += 1;
    byKind[e.kind] += 1;
    if (e.dynamic) dynamicCount += 1;
    if (!nodes.has(e.to)) boundary.add(e.to);
  }

  return {
    edges: sorted,
    nodeCount: nodes.size,
    edgeCount: sorted.length,
    byResolution,
    byKind,
    cycles: detectCycles(nodeIds, sorted),
    boundaryTargets: sortStrings(boundary),
    dynamicCount,
    truncated,
    omittedEdges,
  };
}

function edgeKey(e: CallEdgeRecord): string {
  const c = e.citation;
  // A total order: two edges that differ only in column (two calls on one line)
  // or in dynamic-ness must still order stably, not fall to input order.
  return `${e.from}\0${e.to}\0${e.kind}\0${e.resolution}\0${e.dynamic ? 1 : 0}\0${c.rootName}\0${c.relPath}\0${c.startLine ?? -1}\0${c.startColumn ?? -1}\0${c.endLine ?? -1}\0${c.endColumn ?? -1}`;
}

/**
 * Cycles among resolved edges between known nodes, by DFS. Heuristic/unresolved
 * and boundary edges are excluded — a cycle is only claimed on edges the model
 * resolved. Each cycle is reported once, rotated to start at its smallest node id.
 *
 * This surfaces a representative cycle per back edge, not every simple cycle: a
 * cyclic graph always yields at least one back edge, so at least one cycle is
 * always reported when the graph is cyclic — enough that a cyclic graph is never
 * read as acyclic — but the set is not an exhaustive enumeration.
 */
function detectCycles(nodeIds: readonly string[], edges: readonly CallEdgeRecord[]): readonly (readonly string[])[] {
  const nodes = new Set(nodeIds);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.resolution !== "resolved") continue;
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  }
  for (const [, outs] of adj) outs.sort();

  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        const start = stack.indexOf(next);
        if (start !== -1) {
          const cycle = stack.slice(start);
          const canonical = canonicalCycle(cycle);
          const key = canonical.join("\0");
          if (!seenCycle.has(key)) {
            seenCycle.add(key);
            cycles.push(canonical);
          }
        }
      } else if (c === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  };

  for (const node of [...nodeIds].sort()) if ((color.get(node) ?? 0) === 0) visit(node);
  return cycles.sort((a, b) => (a.join("\0") < b.join("\0") ? -1 : 1));
}

/** Rotate a cycle so it starts at its smallest node id — a stable representative. */
function canonicalCycle(cycle: readonly string[]): string[] {
  let min = 0;
  for (let i = 1; i < cycle.length; i += 1) if (cycle[i]! < cycle[min]!) min = i;
  return [...cycle.slice(min), ...cycle.slice(0, min)];
}

// ---------------------------------------------------------------------------
// Ops entry points (project scope) — three-state, never a takeover manual.
// ---------------------------------------------------------------------------

export type OpsKind = "build" | "test" | "config" | "deploy" | "observability";
export type OpsState = "present" | "absent" | "unknown";

export interface OpsEntry {
  readonly kind: OpsKind;
  readonly name: string;
  readonly state: OpsState;
  readonly reason: string;
  readonly citation: SourceRef | null;
}

export interface OpsReport {
  readonly entries: readonly OpsEntry[];
  readonly byKind: Readonly<Record<OpsKind, number>>;
}

/**
 * The build/test/config/deploy/observability entry points, each present (with a
 * citation), absent, or unknown (with a reason). It never extends a repository
 * signal into a production-operations conclusion.
 */
export function renderOps(entries: readonly OpsEntry[]): OpsReport {
  const opsKey = (e: OpsEntry): string =>
    `${e.kind}\0${e.name}\0${e.state}\0${e.citation ? `${e.citation.relPath}:${e.citation.startLine ?? -1}` : ""}`;
  const sorted = [...entries].sort((a, b) => (opsKey(a) < opsKey(b) ? -1 : opsKey(a) > opsKey(b) ? 1 : 0));
  const byKind: Record<OpsKind, number> = { build: 0, test: 0, config: 0, deploy: 0, observability: 0 };
  for (const e of sorted) byKind[e.kind] += 1;
  return { entries: sorted, byKind };
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

export type ContentValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

export function validateTopology(topology: Topology, modules: readonly ModuleNode[]): ContentValidation {
  const reasons: string[] = [];
  if (topology.moduleCount !== modules.length) reasons.push(`module count ${topology.moduleCount} ≠ ${modules.length}`);
  if (topology.nodes.length !== new Set(topology.nodes.map((n) => n.moduleId)).size) reasons.push("duplicate module in the topology");
  for (const node of topology.nodes) if (!hasCitation(node.citation)) reasons.push(`module ${node.moduleId} has no citation`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateSymbols(set: SymbolSet, symbols: readonly SymbolRecord[]): ContentValidation {
  const reasons: string[] = [];
  if (set.symbolCount !== symbols.length) reasons.push(`symbol count ${set.symbolCount} ≠ ${symbols.length}`);
  if (set.symbols.length !== new Set(set.symbols.map((s) => s.symbolId)).size) reasons.push("duplicate symbol in the set");
  for (const s of set.symbols) if (!hasCitation(s.citation)) reasons.push(`symbol ${s.symbolId} has no citation`);
  for (const e of set.entries) if (!hasCitation(e.citation)) reasons.push(`entry ${e.symbolId} has no citation`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * The graph draws no edge that is not in the model, and every edge is locatable:
 * an edge whose source node is unknown, or that lacks a citation, is rejected. An
 * edge to an unknown target is allowed only when it is surfaced as a boundary.
 */
export function validateCallGraph(graph: CallGraph, nodeIds: readonly string[]): ContentValidation {
  const reasons: string[] = [];
  const nodes = new Set(nodeIds);
  const boundary = new Set(graph.boundaryTargets);
  const byResolution = EDGE_RESOLUTIONS.reduce((n, r) => n + graph.byResolution[r], 0);
  if (byResolution !== graph.edgeCount) reasons.push(`resolutions sum to ${byResolution}, not ${graph.edgeCount}`);
  const byKind = EDGE_KINDS.reduce((n, k) => n + graph.byKind[k], 0);
  if (byKind !== graph.edgeCount) reasons.push(`kinds sum to ${byKind}, not ${graph.edgeCount}`);
  for (const e of graph.edges) {
    if (!nodes.has(e.from)) reasons.push(`edge from unknown node ${e.from}`);
    if (!nodes.has(e.to) && !boundary.has(e.to)) reasons.push(`edge to ${e.to} is neither a node nor a boundary`);
    if (!hasCitation(e.citation)) reasons.push(`edge ${e.from}->${e.to} has no citation`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateOps(report: OpsReport): ContentValidation {
  const reasons: string[] = [];
  for (const e of report.entries) {
    if (e.state === "present" && (e.citation === null || !hasCitation(e.citation))) reasons.push(`${e.kind} ${e.name} is present with no citation`);
    if (e.state === "unknown" && e.reason.length === 0) reasons.push(`${e.kind} ${e.name} is unknown with no reason`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Authored-block contract.
// ---------------------------------------------------------------------------

export interface AuthoredBlockContract {
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly promptId: string;
  readonly citationRule: "required";
  readonly validatorId: string;
  readonly inputFactKinds: readonly FactKind[];
  readonly prompt: string;
}

const DEVELOPER_RULES = [
  "Write for a developer: keep real repository, module, symbol names and source locations verbatim, and cite every claim by its fact id.",
  "State only what the cited facts support; never draw an edge, entry or relationship the model does not hold.",
  "Keep resolved, heuristic and unresolved distinct; mark dynamic calls, third-party boundaries, cycles and truncation rather than smoothing them over.",
  "Do not infer production version, traffic, capacity, incidents, RTO/RPO or alerting from repository configuration; say unknown.",
].join("\n");

/** project-architecture.boundaries — the architecture and technical-boundary notes. */
export const ARCHITECTURE_NOTES_BLOCK: AuthoredBlockContract = {
  blockId: "project-architecture.boundaries",
  outputSchemaId: "architecture-notes.v1",
  promptId: "architecture-notes.v1",
  citationRule: "required",
  validatorId: "architecture-notes.v1",
  inputFactKinds: ["module"],
  prompt: `Describe the repository/module architecture and its technical boundaries from the topology you are given.\n\n${DEVELOPER_RULES}`,
};

export const DEV_ARCHITECTURE_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [ARCHITECTURE_NOTES_BLOCK];
