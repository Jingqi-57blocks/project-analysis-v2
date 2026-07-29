/**
 * Builds each feature's request flows from what the providers established.
 *
 * The chain is assembled from four independent observations — a browser call,
 * a route, a handler symbol, the tables a file touches — none of which knows
 * about the others. Joining them is this tool's work, and the join must never
 * invent a hop: where the evidence stops, the step says so.
 */

import type { DataAccessRecord, OutboundCallRecord, RouteRecord } from "../structural/boundaries.js";
import type { SymbolRecord } from "../structural/code.js";
import type { ValidationRuleRecord } from "../structural/rules.js";
import type { CrossRootLink } from "../linking/types.js";
import type { DomainFeature } from "../modules/features.js";
import { featureForRoute } from "../modules/features.js";
import type { FeatureFlow, FlowStep, FlowSet } from "./types.js";

export interface FlowInput {
  readonly features: readonly DomainFeature[];
  readonly routes: readonly RouteRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly links: readonly CrossRootLink[];
  readonly calls: readonly OutboundCallRecord[];
  readonly dataAccess: readonly DataAccessRecord[];
  readonly validations: readonly ValidationRuleRecord[];
  /** Why a route has no handler symbol, keyed by entry key. */
  readonly handlerGaps: ReadonlyMap<string, string>;
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

  const inFile = sameRoot.filter((access) => access.provenance.source.relPath === relPath);
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
  const scope = inFile.length > 0 ? "file" : "package";

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
        ...(scope === "package" ? ["observed in the handler's package"] : []),
      ],
      unresolvedReason: null,
      provenance: record.provenance,
    }));

  if (byTable.size > limits.maxTables) {
    steps.push({
      kind: "data-access",
      label: `${byTable.size - limits.maxTables} more tables`,
      rootName: route.rootName,
      conditions: [],
      unresolvedReason: `only the first ${limits.maxTables} tables are shown`,
      provenance: null,
    });
  }

  return steps;
}

function outboundSteps(
  route: RouteRecord,
  symbol: SymbolRecord | null,
  links: readonly CrossRootLink[],
): FlowStep[] {
  if (symbol === null) return [];

  const relPath = symbol.provenance.source.relPath;
  const packagePath = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const outgoing = links.filter((link) => {
    if (link.fromRoot !== route.rootName) return false;
    const from = link.provenance.source.relPath;
    const fromPackage = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    return fromPackage === packagePath;
  });

  const seen = new Set<string>();
  const steps: FlowStep[] = [];
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
    const steps: FlowStep[] = [
      frontendStep(route, input.links),
      routeStep(route),
      handler.step,
      ...outboundSteps(route, handler.symbol, input.links),
      ...dataSteps(route, handler.symbol, input.dataAccess, limits),
    ];

    flows.push({
      featureId: feature.id,
      featureName: feature.name,
      entryKey: entryKeyOf(route),
      method: route.method,
      path: route.path,
      steps,
      partial: steps.some((step) => step.unresolvedReason !== null),
    });
  }

  flows.sort((a, b) => a.featureName.localeCompare(b.featureName) || a.entryKey.localeCompare(b.entryKey));
  return { flows, skipped };
}
