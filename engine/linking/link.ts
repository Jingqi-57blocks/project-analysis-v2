/**
 * Resolves outbound calls to the routes they reach, across roots.
 */

import { joinKey } from "../structural/identity.js";
import { inferred, type Provenance } from "../structural/provenance.js";
import type { OutboundCallRecord, RouteRecord } from "../structural/boundaries.js";
import type { CrossRootLink, LinkResult, UnlinkedCall } from "./types.js";

/**
 * The path portion of a destination.
 *
 * A destination may be a full URL, a bare path, or something that is neither.
 * Everything after the host is what a route could match; the host itself
 * identifies the service and is deliberately not used for matching, since a
 * service's hostname in configuration rarely resembles its root's name.
 */
export function pathOf(target: string): string | null {
  const url = /^[a-zA-Z][\w+.-]*:\/\/[^/]*(\/[^?#]*)?/.exec(target);
  if (url) return url[1] ?? "/";
  if (target.startsWith("/")) return target.split(/[?#]/)[0]!;
  return null;
}

/** Trailing slashes carry no meaning in a route, and an empty path is the root. */
function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Whether a declared route pattern matches a concrete path.
 *
 * Route parameters (`:id`, `{id}`, `<id>`) match exactly one segment;
 * wildcards (`*`, `*any`) match the rest. Matching is done on segments rather
 * than by converting the pattern to a regular expression, because a pattern is
 * user data and building a regex from it would let a route's own text change
 * how matching behaves.
 */
export function routeMatches(pattern: string, path: string): boolean {
  const patternSegments = normalizePath(pattern).split("/");
  const pathSegments = normalizePath(path).split("/");

  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i]!;

    if (segment.startsWith("*")) {
      // A wildcard is terminal: it consumes the rest of the path, and anything
      // written after it is not matched against anything. The bounds check
      // comes first, or `/orders/*/confirm` would "match" `/orders`, which
      // never reaches the wildcard's position at all.
      return i <= pathSegments.length;
    }
    if (i >= pathSegments.length) return false;

    const isParameter =
      segment.startsWith(":") ||
      (segment.startsWith("{") && segment.endsWith("}")) ||
      (segment.startsWith("<") && segment.endsWith(">"));
    if (isParameter) continue;

    if (segment !== pathSegments[i]) return false;
  }

  return patternSegments.length === pathSegments.length;
}

/**
 * How specific a pattern is, so an exact route beats a wildcard one.
 *
 * Scoring stops at the wildcard, because matching stops there too. Counting
 * segments written after a wildcard would let `/webhooks/*​/a/b/c` outscore
 * `/webhooks/:provider` on segments that were never compared to anything — and
 * since the winner is taken by plain maximum, that decoy would silently win
 * outright rather than being flagged ambiguous.
 */
function specificity(pattern: string): number {
  let score = 0;
  for (const segment of normalizePath(pattern).split("/")) {
    if (segment.startsWith("*")) break;
    if (segment.startsWith(":") || segment.startsWith("{") || segment.startsWith("<")) score += 1;
    else score += 2;
  }
  return score;
}

/**
 * Whether a call's method can reach a route's.
 *
 * A route with no method answers any of them, and a call that states none
 * could be any — in both cases the method adds no constraint and the path
 * decides. When both are stated, they must agree: without this, a GET matches
 * the POST at the same path just as well, and the pair is reported as an
 * ambiguity that the source had already settled.
 */
export function methodMatches(callMethod: string | null, routeMethod: string | null): boolean {
  if (callMethod === null || routeMethod === null) return true;
  return callMethod.toUpperCase() === routeMethod.toUpperCase();
}

function linkProvenance(call: OutboundCallRecord, route: RouteRecord): Provenance {
  // A link is always an inference: it joins a URL literal to a route pattern,
  // and neither side states the other exists. The confidence reflects how much
  // the route pattern actually constrained the match — a wildcard route
  // matching everything is weak evidence that this particular call reaches it.
  const wildcard = route.path.includes("*");
  return inferred(call.provenance.source, wildcard ? "low" : "medium");
}

/**
 * Links outbound calls to routes across roots.
 *
 * A call is never linked to a route in its own root: an in-process call does
 * not cross a service boundary, and reporting one as a cross-root link would
 * invent an integration that does not exist.
 *
 * Ambiguity is preserved rather than resolved. Two roots declaring the same
 * path is a real finding — often a genuine duplication or a misrouted call —
 * and picking one would hide it behind a confident answer.
 */
export function linkCalls(
  calls: readonly OutboundCallRecord[],
  routes: readonly RouteRecord[],
): LinkResult {
  const links: CrossRootLink[] = [];
  const unlinked: UnlinkedCall[] = [];

  for (const call of calls) {
    if (call.target === null) {
      unlinked.push({
        fromRoot: call.rootName,
        fromSymbolId: call.callerSymbolId,
        target: null,
        reason: "target-not-resolved",
        candidates: [],
        provenance: call.provenance,
      });
      continue;
    }

    const path = pathOf(call.target);
    if (path === null) {
      unlinked.push({
        fromRoot: call.rootName,
        fromSymbolId: call.callerSymbolId,
        target: call.target,
        // Not "external": a relative reference or a queue name is unparsed,
        // and calling it external asserts a boundary nobody established.
        reason: "unparsed-destination",
        candidates: [],
        provenance: call.provenance,
      });
      continue;
    }

    const matches = routes.filter(
      (route) =>
        route.rootName !== call.rootName &&
        routeMatches(route.path, path) &&
        methodMatches(call.method, route.method),
    );

    if (matches.length === 0) {
      unlinked.push({
        fromRoot: call.rootName,
        fromSymbolId: call.callerSymbolId,
        target: call.target,
        // A path that no root declares points outside the workspace, which is
        // a fact about the system rather than a failure of the matcher.
        reason: "no-matching-route",
        candidates: [],
        provenance: call.provenance,
      });
      continue;
    }

    const best = Math.max(...matches.map((route) => specificity(route.path)));
    const winners = matches.filter((route) => specificity(route.path) === best);

    if (winners.length > 1) {
      unlinked.push({
        fromRoot: call.rootName,
        fromSymbolId: call.callerSymbolId,
        target: call.target,
        reason: "ambiguous-match",
        candidates: winners.map((route) => `${route.rootName}:${route.method ?? "ANY"} ${route.path}`),
        provenance: call.provenance,
      });
      continue;
    }

    const route = winners[0]!;
    links.push({
      fromRoot: call.rootName,
      fromSymbolId: call.callerSymbolId,
      target: call.target,
      toRoot: route.rootName,
      toMethod: route.method,
      toPath: route.path,
      toHandlerSymbolId: route.handlerSymbolId,
      kind: call.kind === "http" ? "http-route" : call.kind,
      provenance: linkProvenance(call, route),
    });
  }

  return { links, unlinked, considered: calls.length };
}

/** Roots that call each other, derived from links rather than counted twice. */
export function rootDependencies(
  result: LinkResult,
): readonly { readonly from: string; readonly to: string; readonly calls: number }[] {
  // Keyed through the shared escaping helper rather than an ad hoc separator.
  // Root names come from directory basenames and routinely contain spaces, so
  // an unescaped join lets two different pairs collide into one.
  const pairs = new Map<string, { from: string; to: string; calls: number }>();
  for (const link of result.links) {
    const key = joinKey([link.fromRoot, link.toRoot]);
    const existing = pairs.get(key);
    if (existing) existing.calls += 1;
    else pairs.set(key, { from: link.fromRoot, to: link.toRoot, calls: 1 });
  }

  return [...pairs.values()]
    .sort((a, b) => b.calls - a.calls || a.from.localeCompare(b.from));
}
