/**
 * Builds each feature's request flows from what the providers established.
 *
 * The chain is assembled from four independent observations — a browser call,
 * a route, a handler symbol, the tables a file touches — none of which knows
 * about the others. Joining them is this tool's work, and the join must never
 * invent a hop: where the evidence stops, the step says so.
 */

import type { DataAccessRecord, OutboundCallRecord, RouteRecord } from "../structural/boundaries.js";
import type {
  ReferenceRecord,
  SymbolRecord,
  TypeRelationRecord,
} from "../structural/code.js";
import type { ConditionRecord, GuardRecord, ValidationRuleRecord } from "../structural/rules.js";
import type { CrossRootLink } from "../linking/types.js";
import type { DomainFeature } from "../modules/features.js";
import { featureForRoute } from "../modules/features.js";
import type { FeatureFlow, FlowStep, FlowSet } from "./types.js";
import type { Trace } from "../modules/trace.js";
import { looksInfrastructural } from "../modules/form.js";
import { inferred, type Provenance } from "../structural/provenance.js";

export interface FlowInput {
  readonly features: readonly DomainFeature[];
  readonly routes: readonly RouteRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly links: readonly CrossRootLink[];
  readonly calls: readonly OutboundCallRecord[];
  readonly dataAccess: readonly DataAccessRecord[];
  readonly validations: readonly ValidationRuleRecord[];
  readonly conditions?: readonly ConditionRecord[];
  readonly guards?: readonly GuardRecord[];
  /** Bounded route traces already built from the shared call graph. */
  readonly traces?: readonly Trace[];
  /** Symbol-local references, including concrete types instantiated by an entry. */
  readonly references?: readonly ReferenceRecord[];
  /** Type relationships used to disambiguate interface dispatch per entry. */
  readonly typeRelations?: readonly TypeRelationRecord[];
  /** Why a route has no handler symbol, keyed by entry key. */
  readonly handlerGaps: ReadonlyMap<string, string>;
}

interface ContextualTraceStep {
  readonly symbol: SymbolRecord;
  /** Replaced interface targets are inferred from entry-local construction. */
  readonly provenance: Provenance;
  readonly contextResolved: boolean;
}

function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key) ?? new Set<V>();
  values.add(value);
  map.set(key, values);
}

/**
 * Correct a context-insensitive interface target only when the graph contains
 * enough evidence to choose exactly one implementation for this entry.
 *
 * CodeGraph resolves a call made through an interface to one concrete method.
 * That target is useful for reachability, but it is not necessarily the object
 * constructed by the current route. An entry-local `instantiates` edge tells
 * us which subtype is actually supplied. If the recorded target and that
 * subtype implement the same interface and the subtype owns one method with
 * the same name, the latter is the contextual target. Anything less stays as
 * reported; no type or method name is guessed.
 */
function contextualTraceSteps(
  trace: Trace | undefined,
  symbols: readonly SymbolRecord[],
  references: readonly ReferenceRecord[],
  typeRelations: readonly TypeRelationRecord[],
): readonly ContextualTraceStep[] {
  if (trace === undefined) return [];

  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol] as const));
  const entryId = trace.steps[0]?.symbolId;
  if (entryId === undefined) return [];

  const instantiationByType = new Map(
    references
      .filter((reference) => reference.kind === "instantiate" && reference.fromSymbolId === entryId)
      .map((reference) => [reference.symbolId, reference] as const),
  );
  if (instantiationByType.size === 0) {
    return trace.steps.flatMap((step) => {
      const symbol = symbolsById.get(step.symbolId);
      return symbol === undefined
        ? []
        : [{ symbol, provenance: symbol.provenance, contextResolved: false }];
    });
  }

  const supertypesBySubtype = new Map<string, Set<string>>();
  for (const relation of typeRelations) {
    if (relation.supertypeId !== null) {
      addToSetMap(supertypesBySubtype, relation.subtypeId, relation.supertypeId);
    }
  }

  const methodsByName = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    if (symbol.kind !== "method" || symbol.containerId === null) continue;
    const methods = methodsByName.get(symbol.name) ?? [];
    methods.push(symbol);
    methodsByName.set(symbol.name, methods);
  }

  const instantiatedTypes = new Set(instantiationByType.keys());
  const seen = new Set<string>();
  const resolved: ContextualTraceStep[] = [];

  for (const step of trace.steps) {
    const original = symbolsById.get(step.symbolId);
    if (original === undefined) continue;

    let chosen = original;
    let evidence: ReferenceRecord | undefined;
    let contextResolved = false;
    const originalContainer = original.containerId;
    if (
      original.kind === "method" &&
      originalContainer !== null &&
      !instantiatedTypes.has(originalContainer)
    ) {
      const originalSupers = supertypesBySubtype.get(originalContainer) ?? new Set<string>();
      const alternatives = (methodsByName.get(original.name) ?? []).filter((candidate) => {
        if (candidate.containerId === null || !instantiatedTypes.has(candidate.containerId)) return false;
        const candidateSupers = supertypesBySubtype.get(candidate.containerId) ?? new Set<string>();
        return [...originalSupers].some((supertype) => candidateSupers.has(supertype));
      });
      if (alternatives.length === 1) {
        chosen = alternatives[0]!;
        evidence = instantiationByType.get(chosen.containerId!);
        contextResolved = evidence !== undefined;
      } else if (originalSupers.size > 0) {
        // The current entry instantiated another member of the same interface
        // family, so retaining a method on the context-insensitive target would
        // be a known-wrong claim. Without one replacement, omit the step.
        const hasActiveSibling = [...instantiatedTypes].some((typeId) => {
          const activeSupers = supertypesBySubtype.get(typeId) ?? new Set<string>();
          return [...originalSupers].some((supertype) => activeSupers.has(supertype));
        });
        if (hasActiveSibling) continue;
      }
    }

    if (seen.has(chosen.id)) continue;
    seen.add(chosen.id);
    resolved.push({
      symbol: chosen,
      provenance: contextResolved && evidence !== undefined
        ? inferred(evidence.source, "high")
        : chosen.provenance,
      contextResolved,
    });
  }
  return resolved;
}

function traceFiles(
  steps: readonly ContextualTraceStep[],
): ReadonlySet<string> {
  return new Set(steps.map(({ symbol }) =>
    `${symbol.provenance.source.rootName}\0${symbol.provenance.source.relPath}`,
  ));
}

function traceSymbolIds(steps: readonly ContextualTraceStep[]): ReadonlySet<string> {
  return new Set(steps.map(({ symbol }) => symbol.id));
}

function ruleConditions(
  symbol: SymbolRecord,
  validations: readonly ValidationRuleRecord[],
  conditions: readonly ConditionRecord[],
  guards: readonly GuardRecord[],
): readonly string[] {
  const source = symbol.provenance.source;
  const sameFile = (rootName: string, relPath: string): boolean =>
    rootName === source.rootName && relPath === source.relPath;
  const names = new Set([symbol.name, symbol.qualifiedName ?? symbol.name]);
  return [...new Set([
    ...validations
      .filter((record) => sameFile(record.rootName, record.source.relPath) && (record.subjectSymbolId === null || record.subjectSymbolId === symbol.id))
      .map((record) => record.field === null ? `校验 ${record.rule}` : `校验 ${record.field}（${record.rule}）`),
    ...guards
      .filter((record) => sameFile(record.rootName, record.source.relPath) && (record.enclosingFunction === null || names.has(record.enclosingFunction)))
      .map((record) => `${record.test}：${record.message}`),
    ...conditions
      .filter((record) => sameFile(record.rootName, record.source.relPath) && (record.enclosingFunction === null || names.has(record.enclosingFunction)))
      .map((record) => record.fullTest ?? record.text),
  ])].sort().slice(0, 6);
}

function serviceSteps(
  trace: Trace | undefined,
  contextual: readonly ContextualTraceStep[],
  validations: readonly ValidationRuleRecord[],
  conditions: readonly ConditionRecord[],
  guards: readonly GuardRecord[],
): FlowStep[] {
  if (trace === undefined) return [];
  const steps: FlowStep[] = [];
  for (const { symbol, provenance, contextResolved } of contextual.slice(1)) {
    if (looksInfrastructural(symbol.name)) continue;
    steps.push({
      kind: "service",
      label: symbol.qualifiedName ?? symbol.name,
      rootName: symbol.provenance.source.rootName,
      conditions: [
        ...(contextResolved ? ["根据入口实例化类型解析接口分派"] : []),
        ...ruleConditions(symbol, validations, conditions, guards),
      ].slice(0, 6),
      unresolvedReason: null,
      provenance,
    });
    if (steps.length >= 12) break;
  }
  if (trace.steps.length - 1 > steps.length && steps.length >= 12) {
    steps.push({
      kind: "service",
      label: `${trace.steps.length - 1 - steps.length} 个后续调用未展开`,
      rootName: trace.entryRoot,
      conditions: [],
      unresolvedReason: "调用路径为保持可读性已截断",
      truncated: true,
      provenance: null,
    });
  }
  return steps;
}

export interface FlowLimits {
  /** Tables shown per flow, so one broad handler cannot fill a page. */
  readonly maxTables: number;
}

export const DEFAULT_FLOW_LIMITS: FlowLimits = { maxTables: 12 };

export function entryKeyOf(route: RouteRecord): string {
  return `${route.rootName}:${route.method ?? "ANY"} ${route.path}`;
}

function frontendStep(
  route: RouteRecord,
  links: readonly CrossRootLink[],
): FlowStep {
  const reaching = links.filter(
    (link) =>
      link.toRoot === route.rootName &&
      link.toPath === route.path &&
      (link.toMethod === route.method || link.toMethod === null || route.method === null),
  );

  if (reaching.length === 0) {
    return {
      kind: "frontend-call",
      label: "no caller observed",
      rootName: null,
      conditions: [],
      unresolvedReason:
        "no call in the analyzed roots resolves to this endpoint; it may be called by something outside the workspace",
      provenance: null,
    };
  }

  const callers = [...new Set(reaching.map((link) => link.fromRoot))].sort();
  return {
    kind: "frontend-call",
    label: callers.join(", "),
    rootName: callers[0]!,
    conditions: [],
    unresolvedReason: null,
    provenance: reaching[0]!.provenance,
  };
}

function routeStep(route: RouteRecord): FlowStep {
  return {
    kind: "route",
    label: `${route.method ?? "ANY"} ${route.path}`,
    rootName: route.rootName,
    conditions: route.middleware.map((name) => `middleware ${name}`),
    unresolvedReason: null,
    provenance: route.provenance,
  };
}

function handlerStep(
  route: RouteRecord,
  symbolsById: ReadonlyMap<string, SymbolRecord>,
  handlerGaps: ReadonlyMap<string, string>,
  validations: readonly ValidationRuleRecord[],
): { step: FlowStep; symbol: SymbolRecord | null } {
  const symbol = route.handlerSymbolId ? symbolsById.get(route.handlerSymbolId) ?? null : null;

  if (symbol === null) {
    return {
      step: {
        kind: "handler",
        label: route.handlerName ?? "unknown handler",
        rootName: route.rootName,
        conditions: [],
        unresolvedReason:
          handlerGaps.get(entryKeyOf(route)) ??
          (route.handlerName === null
            ? "the registration passes an inline function, which has no name to resolve"
            : "the handler was not resolved to a symbol in this service"),
        provenance: null,
      },
      symbol: null,
    };
  }

  const relPath = symbol.provenance.source.relPath;
  const conditions = validations
    .filter(
      (rule) => rule.rootName === route.rootName && rule.source.relPath === relPath,
    )
    .map((rule) => (rule.field === null ? `validates ${rule.rule}` : `validates ${rule.field} (${rule.rule})`));

  return {
    step: {
      kind: "handler",
      label: symbol.qualifiedName ?? symbol.name,
      rootName: route.rootName,
      conditions: [...new Set(conditions)].sort().slice(0, 6),
      unresolvedReason: null,
      provenance: symbol.provenance,
    },
    symbol,
  };
}

function dataSteps(
  route: RouteRecord,
  symbol: SymbolRecord | null,
  dataAccess: readonly DataAccessRecord[],
  limits: FlowLimits,
  reachedFiles: ReadonlySet<string> = new Set(),
  reachedSymbolIds: ReadonlySet<string> = new Set(),
): FlowStep[] {
  if (symbol === null) {
    return [
      {
        kind: "data-access",
        label: "unknown",
        rootName: route.rootName,
        conditions: [],
        unresolvedReason:
          "the handler was not resolved, so the data it touches could not be followed",
        provenance: null,
      },
    ];
  }

  // The handler's own file first, and only its package when that file shows
  // nothing. A JS service file queries its own tables, so the file is exact;
  // a Go handler splits one feature across router.go and service.go, so the
  // file alone reaches the database for almost nothing. Trying the narrow
  // scope first keeps the precise answer where one exists instead of
  // attributing every table a shared directory touches to one endpoint.
  const relPath = symbol.provenance.source.relPath;
  const packagePath = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const sameRoot = dataAccess.filter((access) => access.rootName === route.rootName);

  const onTrace = reachedFiles.size === 0
    ? []
    : dataAccess.filter((access) => {
        if (!reachedFiles.has(`${access.rootName}\0${access.provenance.source.relPath}`)) return false;
        if (access.symbolId !== null) return reachedSymbolIds.has(access.symbolId);
        return access.rootName === route.rootName && access.provenance.source.relPath === relPath;
      });
  const inFile = onTrace.length > 0
    ? onTrace
    : sameRoot.filter((access) => access.provenance.source.relPath === relPath);
  const inPackage =
    inFile.length > 0
      ? inFile
      : sameRoot.filter((access) => {
          const accessPath = access.provenance.source.relPath;
          const accessPackage = accessPath.includes("/")
            ? accessPath.slice(0, accessPath.lastIndexOf("/"))
            : "";
          return accessPackage === packagePath;
        });
  const scope = onTrace.length > 0 ? "trace" : inFile.length > 0 ? "file" : "package";

  if (inPackage.length === 0) {
    return [
      {
        kind: "data-access",
        label: "none observed",
        rootName: route.rootName,
        conditions: [],
        // The handler may delegate outside its package, which is not followed
        // without a call graph — so this is an absence of observation, not an
        // observation of absence.
        unresolvedReason:
          "no data access was observed in the handler's package; access through code elsewhere is not followed",
        provenance: null,
      },
    ];
  }

  const byTable = new Map<string, { operations: Set<string>; record: DataAccessRecord }>();
  for (const access of inPackage) {
    const table = access.entity;
    if (table === null) continue;
    const existing = byTable.get(table) ?? { operations: new Set<string>(), record: access };
    if (access.operation !== "unknown") existing.operations.add(access.operation);
    byTable.set(table, existing);
  }

  const steps = [...byTable.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, limits.maxTables)
    .map(([table, { operations, record }]): FlowStep => ({
      kind: "data-access",
      label: table,
      rootName: route.rootName,
      // The scope is part of the claim. "Observed in the handler's package" is
      // a weaker statement than "in the handler itself", and a reader deciding
      // on it needs to know which one this is.
      conditions: [
        ...[...operations].sort(),
        ...(scope === "trace"
          ? ["observed on the traced call path"]
          : scope === "package"
            ? ["observed in the handler's package"]
            : []),
      ],
      unresolvedReason: null,
      indirect: scope === "package",
      provenance: record.provenance,
    }));

  if (byTable.size > limits.maxTables) {
    steps.push({
      kind: "data-access",
      label: `${byTable.size - limits.maxTables} more tables`,
      rootName: route.rootName,
      conditions: [],
      unresolvedReason: `only the first ${limits.maxTables} tables are shown`,
      truncated: true,
      provenance: null,
    });
  }

  return steps;
}

function outboundSteps(
  route: RouteRecord,
  symbol: SymbolRecord | null,
  links: readonly CrossRootLink[],
  calls: readonly OutboundCallRecord[],
  reachedFiles: ReadonlySet<string>,
  reachedSymbolIds: ReadonlySet<string>,
): FlowStep[] {
  if (symbol === null) return [];

  const relPath = symbol.provenance.source.relPath;
  const outgoing = links.filter((link) => {
    if (link.fromRoot !== route.rootName) return false;
    const from = link.provenance.source.relPath;
    if (link.fromSymbolId !== null) return reachedSymbolIds.has(link.fromSymbolId);
    return from === relPath;
  });

  const seen = new Set<string>();
  const steps: FlowStep[] = [];
  for (const call of calls) {
    if (!reachedFiles.has(`${call.rootName}\0${call.provenance.source.relPath}`)) continue;
    if (call.callerSymbolId !== null && !reachedSymbolIds.has(call.callerSymbolId)) continue;
    if (call.callerSymbolId === null && (call.rootName !== route.rootName || call.provenance.source.relPath !== relPath)) continue;
    const label = call.target ?? call.baseIdentifier ?? `${call.kind} target unresolved`;
    if (seen.has(label)) continue;
    seen.add(label);
    steps.push({
      kind: "outbound",
      label,
      rootName: null,
      conditions: [call.method ?? call.kind],
      unresolvedReason: call.target === null && call.baseIdentifier === null ? "outbound target is determined at runtime" : null,
      provenance: call.provenance,
    });
  }
  for (const link of outgoing) {
    const label = `${link.toRoot} ${link.toMethod ?? "ANY"} ${link.toPath}`;
    if (seen.has(label)) continue;
    seen.add(label);
    steps.push({
      kind: "outbound",
      label,
      rootName: link.toRoot,
      conditions: [],
      unresolvedReason: null,
      provenance: link.provenance,
    });
  }
  return steps.slice(0, 6);
}

/**
 * One flow per endpoint, grouped under the feature its path names.
 *
 * A route naming no feature is skipped with that recorded — forcing it into
 * the nearest feature would put endpoints under headings they do not belong
 * to, which is worse than leaving them in the endpoint list.
 */
export function assembleFlows(input: FlowInput, limits: FlowLimits = DEFAULT_FLOW_LIMITS): FlowSet {
  const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
  const tracesByEntry = new Map((input.traces ?? []).map((trace) => [trace.entryKey, trace] as const));
  const flows: FeatureFlow[] = [];
  const skipped: { entryKey: string; reason: string }[] = [];

  for (const route of input.routes) {
    const feature = featureForRoute(route, input.features);
    if (feature === null) {
      skipped.push({
        entryKey: entryKeyOf(route),
        reason: "the path names no detected feature",
      });
      continue;
    }

    const handler = handlerStep(route, symbolsById, input.handlerGaps, input.validations);
    const trace = tracesByEntry.get(entryKeyOf(route));
    const contextual = contextualTraceSteps(
      trace,
      input.symbols,
      input.references ?? [],
      input.typeRelations ?? [],
    );
    const reached = traceFiles(contextual);
    const reachedIds = traceSymbolIds(contextual);
    const steps: FlowStep[] = [
      frontendStep(route, input.links),
      routeStep(route),
      handler.step,
      ...serviceSteps(trace, contextual, input.validations, input.conditions ?? [], input.guards ?? []),
      ...outboundSteps(route, handler.symbol, input.links, input.calls, reached, reachedIds),
      ...dataSteps(route, handler.symbol, input.dataAccess, limits, reached, reachedIds),
    ];

    flows.push({
      featureId: feature.id,
      featureName: feature.name,
      entryKey: entryKeyOf(route),
      method: route.method,
      path: route.path,
      steps,
      // A flow shortened for display is not a flow with a hole in it.
      partial: steps.some((step) => step.unresolvedReason !== null && step.truncated !== true),
    });
  }

  flows.sort((a, b) => a.featureName.localeCompare(b.featureName) || a.entryKey.localeCompare(b.entryKey));
  return { flows, skipped };
}
