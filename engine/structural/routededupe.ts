/**
 * Folds prefix-less route inferences into their directly-observed full paths.
 *
 * A framework reader emits `/oauth/authorize` (resolved) and CodeGraph emits
 * `/authorize` (inferred) for the same registration line. Their record keys
 * differ — the route key is method+path on purpose — so the merge contract
 * never sees them as one fact, and without this step the report would count
 * the route twice and grade one of the copies as a mismatch.
 *
 * The route key itself must not change: keying on the registration site would
 * break cross-provider merging of genuinely identical paths, and "two handlers
 * for one method+path is a conflict" is load-bearing.
 */

import type { RouteRecord } from "./boundaries.js";
import { joinKey } from "./identity.js";
import type { AssembledModel, AssembledRecord, AttributedFailure } from "./assemble.js";
import { PROVIDER_ID as FRAMEWORK_ROUTES } from "../providers/frameworkroutes/provider.js";

/**
 * Whether a record is a framework reader's deliberate incomplete reading.
 *
 * The Gin and Express readers emit an inferred record when they saw a real
 * registration but not its prefix — precisely so the endpoint stays visible.
 * Those must never be absorbed: their subpath tail-matching some other route
 * in the same file is a coincidence, not evidence they are the same fact, and
 * folding them deletes an endpoint nobody else reports.
 */
function isDeliberatelyPartial(record: AssembledRecord): boolean {
  return record.attributions.some((a) => a.providerId === FRAMEWORK_ROUTES);
}

function isDirect(record: AssembledRecord): boolean {
  const provenance = (record.record as RouteRecord).provenance;
  return provenance.resolutionClass === "declared" || provenance.resolutionClass === "resolved";
}

function routeOf(record: AssembledRecord): RouteRecord {
  return record.record as RouteRecord;
}

/**
 * `/oauth/authorize` subsumes `/authorize`; leading slashes make endsWith
 * boundary-safe.
 *
 * A partial of `/` is the registration-at-the-mount-root case — Express's
 * `router.delete('/')` mounted at `/worklogs` serves `/worklogs`, and the
 * literal `/` the registration site shows is a suffix of nothing.
 */
function isPathSuffix(fullPath: string, partial: string): boolean {
  // Trailing slashes are a registration-site detail, not a different route:
  // Express's `/new_entry/` is the same endpoint as `/new_entry`.
  const trimmed = partial.length > 1 ? partial.replace(/\/$/, "") : partial;
  if (trimmed.length === 0 || fullPath === trimmed) return false;
  if (trimmed === "/") return true;
  return fullPath.endsWith(trimmed);
}

function methodsCompatible(winner: RouteRecord, loser: RouteRecord): boolean {
  return winner.method === loser.method || loser.method === null;
}

function fold(winner: AssembledRecord, loser: AssembledRecord): AssembledRecord {
  const winnerRoute = routeOf(winner);
  const loserRoute = routeOf(loser);

  const attributions = [...winner.attributions];
  for (const attribution of loser.attributions) {
    if (!attributions.some((a) => a.providerId === attribution.providerId)) {
      attributions.push(attribution);
    }
  }

  const conflicts = [...winner.conflicts];
  const loserProvider = loser.attributions[0]?.providerId ?? "unknown";
  for (const field of ["path", "middleware", "handlerName"] as const) {
    if (JSON.stringify(winnerRoute[field]) !== JSON.stringify(loserRoute[field])) {
      conflicts.push({
        providerId: loserProvider,
        field,
        value: JSON.stringify(loserRoute[field] ?? null),
      });
    }
  }

  return {
    ...winner,
    attributions,
    conflicts,
    precedenceReason:
      "kept the resolved full path over the inferred prefix-less one from the same registration",
  };
}

/**
 * Consolidates an assembled model's route records.
 *
 * Primary rule: within one registration site (root, file, line), a direct
 * record absorbs an inferred one whose path is a strict suffix of its own.
 * Safety net: in a root where the framework provider produced any direct
 * route, a remaining inferred route in the same file whose path is a suffix of
 * a direct one is likewise absorbed — wrappers can shift the line CodeGraph
 * reports by one or two.
 *
 * Everything else is left alone. Over-suppression would silently discard real
 * routes, and the reference gate's `unexpected` list is what catches it.
 */
export function consolidateRoutes(model: AssembledModel): AssembledModel {
  const routes = model.records.filter((record) => record.kind === "route");
  const others = model.records.filter((record) => record.kind !== "route");
  if (routes.length === 0) return model;

  const claimedRoots = new Set(
    routes
      .filter((record) => record.attributions.some((a) => a.providerId === FRAMEWORK_ROUTES) && isDirect(record))
      .map((record) => routeOf(record).rootName),
  );

  const absorbed = new Set<AssembledRecord>();
  const folded = new Map<AssembledRecord, AssembledRecord>();

  const siteOf = (record: AssembledRecord): string => {
    const source = routeOf(record).provenance.source;
    return joinKey([routeOf(record).rootName, source.relPath, source.startLine]);
  };

  const bySite = new Map<string, AssembledRecord[]>();
  for (const record of routes) {
    const site = siteOf(record);
    const existing = bySite.get(site) ?? [];
    existing.push(record);
    bySite.set(site, existing);
  }

  for (const group of bySite.values()) {
    const direct = group.filter(isDirect);
    const inferredRecords = group.filter(
      (record) => routeOf(record).provenance.resolutionClass === "inferred",
    );
    for (const loser of inferredRecords) {
      if (isDeliberatelyPartial(loser)) continue;
      const winner = direct.find(
        (candidate) =>
          isPathSuffix(routeOf(candidate).path, routeOf(loser).path) &&
          methodsCompatible(routeOf(candidate), routeOf(loser)),
      );
      if (winner) {
        absorbed.add(loser);
        folded.set(winner, fold(folded.get(winner) ?? winner, loser));
      }
    }
  }

  // Safety net across shifted lines, same root and file only.
  const directByRootFile = new Map<string, AssembledRecord[]>();
  for (const record of routes) {
    if (!isDirect(record)) continue;
    const route = routeOf(record);
    const key = joinKey([route.rootName, route.provenance.source.relPath]);
    const existing = directByRootFile.get(key) ?? [];
    existing.push(record);
    directByRootFile.set(key, existing);
  }

  for (const loser of routes) {
    if (absorbed.has(loser)) continue;
    const route = routeOf(loser);
    if (route.provenance.resolutionClass !== "inferred" || !claimedRoots.has(route.rootName)) continue;
    if (isDeliberatelyPartial(loser)) continue;
    // A bare "/" is a suffix of everything, which is precise at one
    // registration site and a coin-flip across a file. Only the site rule
    // above may use it.
    if (route.path === "/") continue;

    const key = joinKey([route.rootName, route.provenance.source.relPath]);
    const winner = (directByRootFile.get(key) ?? []).find(
      (candidate) =>
        isPathSuffix(routeOf(candidate).path, route.path) &&
        methodsCompatible(routeOf(candidate), route),
    );
    if (winner) {
      absorbed.add(loser);
      folded.set(winner, fold(folded.get(winner) ?? winner, loser));
    }
  }

  // A mount is not an endpoint: `app.use("/worklogs", router)` serves no
  // request by itself, and keeping it publishes an endpoint that does not
  // exist. But `app.use("/x", handler)` *is* one, and a mount whose target the
  // reader could not follow is the only record of that prefix — so a mount is
  // dropped only where routes beneath it were actually expanded, which is the
  // evidence that nothing is lost by removing it.
  const expandedPrefixes = new Set<string>();
  for (const record of routes) {
    if (!isDirect(record)) continue;
    const route = routeOf(record);
    expandedPrefixes.add(`${route.rootName}|${route.path}`);
  }
  const wasExpanded = (rootName: string, prefix: string): boolean => {
    const scope = prefix === "/" ? "/" : `${prefix}/`;
    for (const key of expandedPrefixes) {
      if (!key.startsWith(`${rootName}|`)) continue;
      const path = key.slice(rootName.length + 1);
      if (path === prefix || path.startsWith(scope)) return true;
    }
    return false;
  };

  // A root whose screens a reader actually read. An indexer synthesizes a
  // route node per component file, so `src/pages/admin/Employees.tsx` becomes
  // "/admin/Employees" — a module's location dressed as a URL. Where the
  // declarations themselves were read, those synthesized paths are not a
  // second opinion about the same screens; they are a different thing
  // entirely, and publishing them would list directories as addresses.
  const readScreens = new Set(
    routes
      .filter(
        (record) =>
          routeOf(record).surface === "client" &&
          record.attributions.some((a) => a.providerId === FRAMEWORK_ROUTES),
      )
      .map((record) => routeOf(record).rootName),
  );

  const mountFailures: AttributedFailure[] = [];
  const survivors: AssembledRecord[] = [];

  for (const record of routes) {
    if (absorbed.has(record)) continue;
    const route = routeOf(record);

    if (
      route.surface === "client" &&
      readScreens.has(route.rootName) &&
      !record.attributions.some((a) => a.providerId === FRAMEWORK_ROUTES)
    ) {
      mountFailures.push({
        providerId: record.attributions[0]?.providerId ?? "unknown",
        scope: `${route.provenance.source.relPath}:${route.provenance.source.startLine}`,
        reason: `"${route.path}" mirrors a component's file path rather than an address; this application's screens were read from its route declarations instead`,
      });
      continue;
    }

    if (
      route.method === "USE" &&
      route.provenance.resolutionClass === "inferred" &&
      claimedRoots.has(route.rootName) &&
      wasExpanded(route.rootName, route.path)
    ) {
      mountFailures.push({
        providerId: record.attributions[0]?.providerId ?? "unknown",
        scope: `${route.provenance.source.relPath}:${route.provenance.source.startLine}`,
        reason: `"USE ${route.path}" registers a mount, not an endpoint; the routes beneath it are reported at their full paths`,
      });
      continue;
    }

    survivors.push(folded.get(record) ?? record);
  }

  return {
    ...model,
    records: [...others, ...survivors],
    failures: [...model.failures, ...mountFailures],
  };
}
