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

/**
 * Whether a symbol's file agrees with the qualifier a registration wrote.
 *
 * The qualifier means different things per language: `leave.Deletion` names a
 * Go package, which is a directory, while `worklogService.getWorkLogsByUser`
 * names a JS module, which is a file. Matching either — but only as a whole
 * name, never as a substring anywhere in the path — is what separates the
 * twelve functions called `Deletion` in one service.
 */
function fileAgreesWith(relPath: string, hint: string): boolean {
  const slash = relPath.lastIndexOf("/");
  const directory = (slash === -1 ? "" : relPath.slice(0, slash).split("/").pop() ?? "").toLowerCase();
  const basename = relPath
    .slice(slash + 1)
    .replace(/\.\w+$/, "")
    .toLowerCase();

  if (directory === hint || basename === hint) return true;
  // `worklogServices.js` for `worklogService`, and `swagger.go` for
  // `ginSwagger` — a plural or a prefix, not an arbitrary shared substring.
  if (basename.length >= 4 && (basename.startsWith(hint) || hint.includes(basename))) return true;
  return false;
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

      let matches = symbolsHere.filter((symbol) => {
        if (symbol.name !== functionName) return false;
        if (packageHint === null) return true;
        return fileAgreesWith(symbol.provenance.source.relPath, packageHint);
      });

      // `leave.Deletion` names a package-level function. When both a bare
      // function and a method of some type carry the name, the bare one is
      // what the registration referred to — a method would have needed a
      // receiver to be written there at all.
      if (matches.length > 1) {
        const plain = matches.filter((symbol) => !(symbol.qualifiedName ?? "").includes("::"));
        if (plain.length > 0) matches = plain;
      }

      if (matches.length === 1) return { ...route, handlerSymbolId: matches[0]!.id };

      if (matches.length > 1) {
        // Ambiguity means the handler is one of these. Trying the next
        // candidate would answer with a different function entirely — and
        // since the outer candidate is usually a shared wrapper, that answer
        // would resolve confidently and be wrong for hundreds of routes.
        unresolved.push({
          entryKey: entryKeyOf(route),
          handlerName: name,
          reason: `${matches.length} symbols named "${functionName}" match; refusing to pick one`,
        });
        return route;
      }

      reasons.push(
        `no symbol named "${functionName}"${packageHint ? ` in a package named "${packageHint}"` : ""} in ${route.rootName}`,
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
