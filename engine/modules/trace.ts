/**
 * Walks from entry points through the call graph, bounded.
 *
 * Cycles, recursion, callbacks, shared helpers and high fan-out make unbounded
 * walking a trap: one trace through a logging utility absorbs the project.
 * Every trace therefore records why it stopped, and completeness means every
 * entry point and every truncation is accounted for — not that every reachable
 * function was copied into a trace.
 */

import type { CallEdgeRecord, SymbolRecord } from "../structural/code.js";
import type { RouteRecord } from "../structural/boundaries.js";
import type { SymbolId } from "../structural/identity.js";
import type { ResolutionClass } from "../structural/provenance.js";

export interface TraceLimits {
  readonly maxDepth: number;
  readonly maxSteps: number;
  readonly maxBranches: number;
}

export const DEFAULT_LIMITS: TraceLimits = { maxDepth: 12, maxSteps: 200, maxBranches: 16 };

export type TruncationReason =
  | "completed"
  | "cycle"
  | "max-depth"
  | "max-steps"
  | "max-branches"
  | "unresolved-edge";

export interface TraceStep {
  readonly symbolId: SymbolId;
  readonly name: string;
  readonly depth: number;
  readonly rootName: string;
  /** How the edge that reached this step was established. */
  readonly resolution: ResolutionClass;
}

export interface Trace {
  /** Stable across runs: derived from the entry point's identity, not its position. */
  readonly entryKey: string;
  readonly entryRoot: string;
  readonly entryMethod: string | null;
  readonly entryPath: string;
  readonly steps: readonly TraceStep[];
  readonly truncation: TruncationReason;
  /** Set when the walk stopped early, naming what it did not follow. */
  readonly truncationDetail: string | null;
  readonly partial: boolean;
}

export interface TraceInput {
  readonly routes: readonly RouteRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly callEdges: readonly CallEdgeRecord[];
}

export interface TraceResult {
  readonly traces: readonly Trace[];
  /** Entry points that produced no trace, each with a reason. */
  readonly untraced: readonly { readonly entryKey: string; readonly reason: string }[];
  readonly entryPoints: number;
}

function entryKeyOf(route: RouteRecord): string {
  return `${route.rootName}:${route.method ?? "ANY"} ${route.path}`;
}

/**
 * Builds one trace, breadth-first from the entry symbol.
 *
 * Breadth-first rather than depth-first so a depth limit truncates the
 * *shallow* picture last: a reader learns more from "what does this touch
 * immediately" than from one arbitrary deep path through a helper.
 */
function walk(
  entry: SymbolRecord,
  edgesByCaller: ReadonlyMap<SymbolId, readonly CallEdgeRecord[]>,
  symbolsById: ReadonlyMap<SymbolId, SymbolRecord>,
  limits: TraceLimits,
): { steps: TraceStep[]; truncation: TruncationReason; detail: string | null } {
  const steps: TraceStep[] = [];
  const visited = new Set<SymbolId>([entry.id]);
  let queue: { symbol: SymbolRecord; depth: number; resolution: ResolutionClass }[] = [
    { symbol: entry, depth: 0, resolution: entry.provenance.resolutionClass },
  ];
  let truncation: TruncationReason = "completed";
  let detail: string | null = null;

  while (queue.length > 0) {
    const current = queue.shift()!;

    steps.push({
      symbolId: current.symbol.id,
      name: current.symbol.name,
      depth: current.depth,
      rootName: current.symbol.provenance.source.rootName,
      resolution: current.resolution,
    });

    if (steps.length >= limits.maxSteps) {
      truncation = "max-steps";
      detail = `stopped after ${limits.maxSteps} steps`;
      break;
    }
    if (current.depth >= limits.maxDepth) {
      truncation = "max-depth";
      detail = `stopped at depth ${limits.maxDepth}`;
      continue;
    }

    const outgoing = edgesByCaller.get(current.symbol.id) ?? [];
    if (outgoing.length > limits.maxBranches) {
      // A symbol with enormous fan-out is a shared helper, not a step in one
      // feature's story. Following it would pull the whole project into this
      // trace and tell the reader nothing about the feature.
      truncation = "max-branches";
      detail = `${current.symbol.name} has ${outgoing.length} outgoing calls, above the branch limit`;
      continue;
    }

    for (const edge of outgoing) {
      if (edge.calleeId === null) {
        // A trace that walks past an unknown is fiction from that point on.
        if (truncation === "completed") {
          truncation = "unresolved-edge";
          detail = `call to ${edge.calleeName} could not be resolved`;
        }
        continue;
      }
      if (visited.has(edge.calleeId)) {
        if (truncation === "completed") {
          truncation = "cycle";
          detail = `already visited ${edge.calleeName}`;
        }
        continue;
      }

      const callee = symbolsById.get(edge.calleeId);
      if (!callee) continue;

      visited.add(edge.calleeId);
      queue.push({
        symbol: callee,
        depth: current.depth + 1,
        resolution: edge.provenance.resolutionClass,
      });
    }
  }

  return { steps, truncation, detail };
}

export function buildTraces(input: TraceInput, limits: TraceLimits = DEFAULT_LIMITS): TraceResult {
  const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol] as const));

  const edgesByCaller = new Map<SymbolId, CallEdgeRecord[]>();
  for (const edge of input.callEdges) {
    const existing = edgesByCaller.get(edge.callerId) ?? [];
    existing.push(edge);
    edgesByCaller.set(edge.callerId, existing);
  }

  const traces: Trace[] = [];
  const untraced: { entryKey: string; reason: string }[] = [];

  for (const route of input.routes) {
    const entryKey = entryKeyOf(route);
    const entry = route.handlerSymbolId ? symbolsById.get(route.handlerSymbolId) : undefined;

    if (!entry) {
      // An entry point with no resolvable handler is a real gap, not a missing
      // trace to be quietly skipped.
      untraced.push({
        entryKey,
        reason:
          route.handlerSymbolId === null
            ? "the route is not linked to a handler symbol"
            : "the route's handler symbol is not in the model",
      });
      continue;
    }

    const walked = walk(entry, edgesByCaller, symbolsById, limits);
    traces.push({
      entryKey,
      entryRoot: route.rootName,
      entryMethod: route.method,
      entryPath: route.path,
      steps: walked.steps,
      truncation: walked.truncation,
      truncationDetail: walked.detail,
      partial: walked.truncation !== "completed",
    });
  }

  return { traces, untraced, entryPoints: input.routes.length };
}
