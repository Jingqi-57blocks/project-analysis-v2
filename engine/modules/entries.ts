/**
 * Identifying entry points, and tracing from them, without a route reader (PI-10).
 *
 * A route reader gives precise entries; an unfamiliar framework gives none. The
 * generic path still has the call graph, so it can offer *candidate* entries — an
 * exported callable is a way in even when nothing registered it as a route — and,
 * failing that, *structure roots*: callables nothing in the graph calls. Naming
 * which of the three an entry is keeps a report honest: a candidate entry is a
 * lead, not a confirmed endpoint.
 *
 * The traversal is bounded and cycle-aware — cycles, recursion and high fan-out
 * make an unbounded walk a trap. It follows more than calls: a call edge and a
 * type relation (a subtype to its supertype) are both ways one symbol reaches
 * another, and each step records which kind of edge reached it and where that
 * edge is in the source, so a later reader can go back to the evidence.
 * (A `reference` is anchored to a location, not a from-symbol, so it is evidence
 * for behaviour derivation rather than a traversable edge, and is not walked here.)
 */

import type { CallEdgeRecord, SymbolRecord, TypeRelationRecord } from "../structural/code.js";
import type { RouteRecord } from "../structural/boundaries.js";
import type { SymbolId } from "../structural/identity.js";
import type { ResolutionClass, SourceRef } from "../structural/provenance.js";
import { DEFAULT_LIMITS, type TraceLimits, type TruncationReason } from "./trace.js";

/** How sure we are this is a way into the system. */
export type EntryClass = "precise" | "candidate" | "structure-root";

/** What evidence made it an entry. */
export type EntryKind = "route" | "export" | "call-root";

export interface EntryPoint {
  /** Stable across runs: derived from identity, not position. */
  readonly entryKey: string;
  readonly entryClass: EntryClass;
  readonly entryKind: EntryKind;
  readonly rootName: string;
  readonly symbolId: SymbolId;
  readonly name: string;
  /** Route entries only; null otherwise. */
  readonly method: string | null;
  readonly path: string | null;
  readonly resolution: ResolutionClass;
}

export interface EntryInput {
  readonly routes: readonly RouteRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly callEdges: readonly CallEdgeRecord[];
  /** Optional: subtype→supertype edges, walked alongside calls. */
  readonly typeRelations?: readonly TypeRelationRecord[];
}

const CALLABLE: ReadonlySet<string> = new Set(["function", "method", "constructor"]);

function isCallable(symbol: SymbolRecord): boolean {
  return CALLABLE.has(symbol.kind);
}

/**
 * The entries, strongest class first, in a total order. A symbol is classified
 * once: a route handler is precise even if it is also exported, an exported
 * callable is a candidate even if it is also a graph root. That single-claim rule
 * keeps the three sets disjoint; the sort breaks entryKey ties on the unique
 * symbolId so input order never decides the result.
 */
export function identifyEntries(input: EntryInput): readonly EntryPoint[] {
  const symbolsById = new Map(input.symbols.map((s) => [s.id, s] as const));
  const claimed = new Set<SymbolId>();
  const entries: EntryPoint[] = [];

  for (const route of input.routes) {
    const handler = route.handlerSymbolId ? symbolsById.get(route.handlerSymbolId) : undefined;
    if (handler === undefined || claimed.has(handler.id)) continue;
    claimed.add(handler.id);
    entries.push({
      entryKey: `route:${route.rootName}:${route.method ?? "ANY"} ${route.path}`,
      entryClass: "precise",
      entryKind: "route",
      rootName: route.rootName,
      symbolId: handler.id,
      name: handler.name,
      method: route.method,
      path: route.path,
      resolution: route.provenance.resolutionClass,
    });
  }

  for (const symbol of input.symbols) {
    if (claimed.has(symbol.id) || !isCallable(symbol) || symbol.visibility !== "public") continue;
    claimed.add(symbol.id);
    entries.push({
      entryKey: `export:${symbol.provenance.source.rootName}:${symbol.qualifiedName ?? symbol.name}`,
      entryClass: "candidate",
      entryKind: "export",
      rootName: symbol.provenance.source.rootName,
      symbolId: symbol.id,
      name: symbol.name,
      method: null,
      path: null,
      resolution: symbol.provenance.resolutionClass,
    });
  }

  const callees = new Set<SymbolId>();
  for (const edge of input.callEdges) {
    if (edge.calleeId !== null) callees.add(edge.calleeId);
  }
  for (const symbol of input.symbols) {
    if (claimed.has(symbol.id) || !isCallable(symbol) || callees.has(symbol.id)) continue;
    claimed.add(symbol.id);
    entries.push({
      entryKey: `call-root:${symbol.provenance.source.rootName}:${symbol.qualifiedName ?? symbol.name}`,
      entryClass: "structure-root",
      entryKind: "call-root",
      rootName: symbol.provenance.source.rootName,
      symbolId: symbol.id,
      name: symbol.name,
      method: null,
      path: null,
      resolution: symbol.provenance.resolutionClass,
    });
  }

  return entries.sort((a, b) =>
    a.entryKey < b.entryKey
      ? -1
      : a.entryKey > b.entryKey
        ? 1
        : a.symbolId < b.symbolId
          ? -1
          : a.symbolId > b.symbolId
            ? 1
            : 0,
  );
}

export type EntryEdgeKind = "call" | "type";

/** One step, and the edge that reached it — its kind, source, and endpoints. */
export interface EntryTraceStep {
  readonly symbolId: SymbolId;
  readonly name: string;
  readonly depth: number;
  readonly rootName: string;
  readonly resolution: ResolutionClass;
  /** Null for the entry itself; otherwise how this step was reached. */
  readonly edgeKind: EntryEdgeKind | null;
  readonly fromSymbolId: SymbolId | null;
  /** Where the reaching edge is in the source. Null for the entry itself. */
  readonly via: SourceRef | null;
}

/** A resolved or unresolved way out of one symbol, whatever its kind. */
interface OutEdge {
  readonly to: SymbolId | null;
  readonly toName: string;
  readonly kind: EntryEdgeKind;
  readonly resolution: ResolutionClass;
  readonly source: SourceRef;
}

function outEdgesBySource(input: EntryInput): ReadonlyMap<SymbolId, readonly OutEdge[]> {
  const map = new Map<SymbolId, OutEdge[]>();
  const add = (from: SymbolId, edge: OutEdge) => {
    const list = map.get(from) ?? [];
    list.push(edge);
    map.set(from, list);
  };
  for (const call of input.callEdges) {
    add(call.callerId, {
      to: call.calleeId,
      toName: call.calleeName,
      kind: "call",
      resolution: call.provenance.resolutionClass,
      source: call.provenance.source,
    });
  }
  for (const rel of input.typeRelations ?? []) {
    add(rel.subtypeId, {
      to: rel.supertypeId,
      toName: rel.supertypeName,
      kind: "type",
      resolution: rel.provenance.resolutionClass,
      source: rel.provenance.source,
    });
  }
  return map;
}

interface WalkResult {
  readonly steps: EntryTraceStep[];
  readonly truncation: TruncationReason;
  readonly detail: string | null;
}

/**
 * Bounded breadth-first walk from an entry over the unified edge set. Breadth-first
 * so a depth limit truncates the deep picture last; a back-edge to an ancestor is a
 * cycle (a diamond is not); an unresolved target stops the walk from writing fiction.
 */
function walkGraph(
  entry: SymbolRecord,
  outBySource: ReadonlyMap<SymbolId, readonly OutEdge[]>,
  symbolsById: ReadonlyMap<SymbolId, SymbolRecord>,
  limits: TraceLimits,
): WalkResult {
  const steps: EntryTraceStep[] = [
    {
      symbolId: entry.id,
      name: entry.name,
      depth: 0,
      rootName: entry.provenance.source.rootName,
      resolution: entry.provenance.resolutionClass,
      edgeKind: null,
      fromSymbolId: null,
      via: null,
    },
  ];
  const visited = new Set<SymbolId>([entry.id]);
  const parents = new Map<SymbolId, SymbolId>();
  const isAncestor = (candidate: SymbolId, from: SymbolId): boolean => {
    let current: SymbolId | undefined = from;
    while (current !== undefined) {
      if (current === candidate) return true;
      current = parents.get(current);
    }
    return false;
  };

  const queue: { symbol: SymbolRecord; depth: number }[] = [{ symbol: entry, depth: 0 }];
  let truncation: TruncationReason = "completed";
  let detail: string | null = null;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= limits.maxDepth) {
      truncation = "max-depth";
      detail = `stopped at depth ${limits.maxDepth}`;
      continue;
    }
    const outgoing = outBySource.get(current.symbol.id) ?? [];
    if (outgoing.length > limits.maxBranches) {
      truncation = "max-branches";
      detail = `${current.symbol.name} has ${outgoing.length} outgoing edges, above the branch limit`;
      continue;
    }
    for (const edge of outgoing) {
      if (edge.to === null) {
        if (truncation === "completed") {
          truncation = "unresolved-edge";
          detail = `${edge.kind} to ${edge.toName} could not be resolved`;
        }
        continue;
      }
      if (visited.has(edge.to)) {
        if (truncation === "completed" && isAncestor(edge.to, current.symbol.id)) {
          truncation = "cycle";
          detail = `${edge.toName} reaches back into its own caller chain`;
        }
        continue;
      }
      const callee = symbolsById.get(edge.to);
      if (!callee) continue;
      visited.add(edge.to);
      parents.set(edge.to, current.symbol.id);
      steps.push({
        symbolId: callee.id,
        name: callee.name,
        depth: current.depth + 1,
        rootName: callee.provenance.source.rootName,
        resolution: edge.resolution,
        edgeKind: edge.kind,
        fromSymbolId: current.symbol.id,
        via: edge.source,
      });
      if (steps.length >= limits.maxSteps) {
        truncation = "max-steps";
        detail = `stopped after ${limits.maxSteps} steps`;
        return { steps, truncation, detail };
      }
      queue.push({ symbol: callee, depth: current.depth + 1 });
    }
  }

  return { steps, truncation, detail };
}

export interface EntryTrace {
  readonly entryKey: string;
  readonly entryClass: EntryClass;
  readonly entryKind: EntryKind;
  readonly entryRoot: string;
  readonly steps: readonly EntryTraceStep[];
  readonly truncation: TruncationReason;
  readonly truncationDetail: string | null;
  readonly partial: boolean;
}

/** How much of the entry set the traversal could actually follow. */
export interface EntryTraceability {
  readonly total: number;
  readonly precise: number;
  readonly candidate: number;
  readonly structureRoot: number;
  /** Entries whose trace reached at least one edge beyond the entry itself. */
  readonly reachable: number;
  /** reachable / total, 0 when there are no entries. */
  readonly rate: number;
}

export interface EntryTraceResult {
  readonly traces: readonly EntryTrace[];
  readonly traceability: EntryTraceability;
}

/**
 * Identify entries and trace from each, bounded. The traceability rate — how many
 * entries led anywhere — is the honest measure of how much of an unfamiliar
 * project the generic path could follow, reported rather than assumed.
 */
export function buildEntryTraces(input: EntryInput, limits: TraceLimits = DEFAULT_LIMITS): EntryTraceResult {
  const symbolsById = new Map(input.symbols.map((s) => [s.id, s] as const));
  const outBySource = outEdgesBySource(input);

  const entries = identifyEntries(input);
  const traces: EntryTrace[] = [];
  let reachable = 0;
  const counts = { precise: 0, candidate: 0, structureRoot: 0 };

  for (const entry of entries) {
    if (entry.entryClass === "precise") counts.precise += 1;
    else if (entry.entryClass === "candidate") counts.candidate += 1;
    else counts.structureRoot += 1;

    const symbol = symbolsById.get(entry.symbolId)!;
    const walked = walkGraph(symbol, outBySource, symbolsById, limits);
    if (walked.steps.length > 1) reachable += 1;
    traces.push({
      entryKey: entry.entryKey,
      entryClass: entry.entryClass,
      entryKind: entry.entryKind,
      entryRoot: entry.rootName,
      steps: walked.steps,
      truncation: walked.truncation,
      truncationDetail: walked.detail,
      partial: walked.truncation !== "completed",
    });
  }

  return {
    traces,
    traceability: {
      total: entries.length,
      precise: counts.precise,
      candidate: counts.candidate,
      structureRoot: counts.structureRoot,
      reachable,
      rate: entries.length === 0 ? 0 : reachable / entries.length,
    },
  };
}
