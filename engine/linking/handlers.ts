/**
 * Joins routes to the symbols behind them.
 *
 * A framework reader knows a handler's *name* — `leave.Creation`,
 * `worklogService.getWorkLogsByUser` — but cannot mint the symbol identity a
 * structural provider assigned, so the join happens after assembly, when both
 * sides exist. This is the single null that has kept traces empty since MVP 7.
 *
 * Resolution demands uniqueness. One matching symbol resolves; zero or several
 * stay null with the reason recorded — a visible gap beats a confident wrong
 * answer, and a trace walked from the wrong handler would be fiction with
 * good posture.
 *
 * A registration that reads two ways offers both names, most-likely first.
 * Trying them in order settles which layer of `Wrapper(inner)` is the handler
 * by what the repository defines, rather than by a rule guessing at the
 * registration site.
 */

import type { RouteRecord } from "../structural/boundaries.js";
import type { SymbolRecord } from "../structural/code.js";

export interface UnresolvedHandler {
  readonly entryKey: string;
  readonly handlerName: string;
  readonly reason: string;
}

export interface HandlerResolution {
  readonly routes: readonly RouteRecord[];
  readonly unresolved: readonly UnresolvedHandler[];
}

function entryKeyOf(route: RouteRecord): string {
  return `${route.rootName}:${route.method ?? "ANY"} ${route.path}`;
}

export function resolveHandlers(
  routes: readonly RouteRecord[],
  symbols: readonly SymbolRecord[],
): HandlerResolution {
  const byRoot = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const root = symbol.provenance.source.rootName;
    const existing = byRoot.get(root) ?? [];
    existing.push(symbol);
    byRoot.set(root, existing);
  }

  const unresolved: UnresolvedHandler[] = [];

  const resolved = routes.map((route) => {
    const names = route.handlerCandidates.length > 0
      ? route.handlerCandidates
      : route.handlerName === null
        ? []
        : [route.handlerName];
    if (route.handlerSymbolId !== null || names.length === 0) return route;

    const symbolsHere = byRoot.get(route.rootName) ?? [];
    const reasons: string[] = [];

    for (const name of names) {
      const segments = name.split(".");
      const functionName = segments[segments.length - 1]!;
      const packageHint = segments.length > 1 ? segments[segments.length - 2]!.toLowerCase() : null;

      const matches = symbolsHere.filter((symbol) => {
        if (symbol.name !== functionName) return false;
        if (packageHint === null) return true;
        const qualified = (symbol.qualifiedName ?? "").toLowerCase();
        const relPath = symbol.provenance.source.relPath.toLowerCase();
        return qualified.includes(packageHint) || relPath.includes(packageHint);
      });

      if (matches.length === 1) return { ...route, handlerSymbolId: matches[0]!.id };

      reasons.push(
        matches.length === 0
          ? `no symbol named "${functionName}"${packageHint ? ` matching package hint "${packageHint}"` : ""} in ${route.rootName}`
          : `${matches.length} symbols named "${functionName}" match; refusing to pick one`,
      );
    }

    unresolved.push({
      entryKey: entryKeyOf(route),
      handlerName: names[0]!,
      reason: reasons.join("; "),
    });
    return route;
  });

  return { routes: resolved, unresolved };
}
