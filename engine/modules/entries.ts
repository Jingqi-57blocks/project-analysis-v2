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
 * The bounded, cycle-aware traversal is `trace.ts`'s `walk`, reused here rather
 * than re-implemented — this module decides *where to start*, not how to walk.
 */

import type { CallEdgeRecord, SymbolRecord } from "../structural/code.js";
import type { RouteRecord } from "../structural/boundaries.js";
import type { SymbolId } from "../structural/identity.js";
import type { ResolutionClass } from "../structural/provenance.js";
import { DEFAULT_LIMITS, type TraceLimits, type TraceStep, type TruncationReason, walk } from "./trace.js";

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
}

const CALLABLE: ReadonlySet<string> = new Set(["function", "method", "constructor"]);

function isCallable(symbol: SymbolRecord): boolean {
  return CALLABLE.has(symbol.kind);
}

/**
 * The entries, strongest class first, in a stable order. A symbol is classified
 * once: a route handler is precise even if it is also exported, an exported
 * callable is a candidate even if it is also a graph root. This ordering is what
 * keeps the three sets disjoint.
 */
export function identifyEntries(input: EntryInput): readonly EntryPoint[] {
  const symbolsById = new Map(input.symbols.map((s) => [s.id, s] as const));
  const claimed = new Set<SymbolId>();
  const entries: EntryPoint[] = [];

  // Precise: a route whose handler resolved to a symbol we hold.
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

  // Candidate: an exported callable no route claimed. A way in the language
  // exposes, whether or not a framework registered it.
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

  // Structure root: a callable nothing in the graph calls. The weakest signal —
  // used only when the stronger two did not already claim the symbol.
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

  return entries.sort((a, b) => (a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0));
}

export interface EntryTrace {
  readonly entryKey: string;
  readonly entryClass: EntryClass;
  readonly entryKind: EntryKind;
  readonly entryRoot: string;
  readonly steps: readonly TraceStep[];
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
  /** Entries whose trace reached at least one call beyond the entry itself. */
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
  const edgesByCaller = new Map<SymbolId, CallEdgeRecord[]>();
  for (const edge of input.callEdges) {
    const list = edgesByCaller.get(edge.callerId) ?? [];
    list.push(edge);
    edgesByCaller.set(edge.callerId, list);
  }

  const entries = identifyEntries(input);
  const traces: EntryTrace[] = [];
  let reachable = 0;
  const counts = { precise: 0, candidate: 0, structureRoot: 0 };

  for (const entry of entries) {
    if (entry.entryClass === "precise") counts.precise += 1;
    else if (entry.entryClass === "candidate") counts.candidate += 1;
    else counts.structureRoot += 1;

    const symbol = symbolsById.get(entry.symbolId)!;
    const walked = walk(symbol, edgesByCaller, symbolsById, limits);
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
