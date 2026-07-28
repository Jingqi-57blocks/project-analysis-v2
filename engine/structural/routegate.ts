/**
 * Grades extracted routes against hand-verified ground truth.
 *
 * The gate is deliberately **not** "everything must be extracted". A gate
 * demanding total recall creates pressure to bolt per-language hacks into the
 * engine to pass it, which is the exact failure the provider architecture
 * exists to prevent. What it demands instead is that every reference route be
 * *accounted for*: extracted, or explicitly dispositioned with the capability
 * gap responsible for its absence named.
 *
 * A gap that matters is a signal to add a provider, not a reason to lower the
 * bar or to quietly drop the route from the reference.
 */

import type { RouteRecord } from "./boundaries.js";
import type { CapabilityGap } from "./provider.js";

export interface ReferenceRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: string | null;
}

export type RouteDisposition = "extracted" | "path-mismatch" | "missing";

export interface GradedRoute {
  readonly reference: ReferenceRoute;
  readonly disposition: RouteDisposition;
  /** Why it was not extracted exactly. Null only when it was. */
  readonly reason: string | null;
  /** A route we produced that looks like this one but disagrees about the path. */
  readonly nearestExtractedPath: string | null;
}

export interface RouteGrade {
  readonly graded: readonly GradedRoute[];
  /** Extracted routes with no counterpart in the reference. */
  readonly unexpected: readonly string[];
  readonly extracted: number;
  readonly pathMismatch: number;
  readonly missing: number;
}

function methodOf(route: RouteRecord): string {
  // The model uses null for an all-methods route; the reference spells it ANY.
  return route.method ?? "ANY";
}

/**
 * Whether an extracted path is the reference path missing a leading group
 * prefix — the single most common framework-routing failure, and the one
 * worth distinguishing from a route that was never found at all.
 *
 * A path mismatch and a missing route call for different fixes: the first
 * means the registration was seen but its prefix was not resolved, the second
 * means the registration was never seen. Reporting both as "missing" would
 * hide which one is actually wrong.
 */
function isSuffixOf(extractedPath: string, referencePath: string): boolean {
  return extractedPath !== referencePath && referencePath.endsWith(extractedPath);
}

export function gradeRoutes(
  extracted: readonly RouteRecord[],
  reference: readonly ReferenceRoute[],
  gaps: readonly CapabilityGap[] = [],
): RouteGrade {
  const routeGapReason =
    gaps.find((gap) => gap.kind === "route")?.reason ?? "no provider resolved this route";

  const matched = new Set<string>();
  const graded: GradedRoute[] = [];

  for (const wanted of reference) {
    const exact = extracted.find(
      (route) => methodOf(route) === wanted.method && route.path === wanted.path,
    );
    if (exact) {
      matched.add(`${methodOf(exact)} ${exact.path}`);
      graded.push({
        reference: wanted,
        disposition: "extracted",
        reason: null,
        nearestExtractedPath: exact.path,
      });
      continue;
    }

    const nearMiss = extracted.find(
      (route) => methodOf(route) === wanted.method && isSuffixOf(route.path, wanted.path),
    );
    if (nearMiss) {
      matched.add(`${methodOf(nearMiss)} ${nearMiss.path}`);
      graded.push({
        reference: wanted,
        disposition: "path-mismatch",
        reason: `registration was found but the path is incomplete: extracted "${nearMiss.path}", expected "${wanted.path}"`,
        nearestExtractedPath: nearMiss.path,
      });
      continue;
    }

    graded.push({
      reference: wanted,
      disposition: "missing",
      reason: routeGapReason,
      nearestExtractedPath: null,
    });
  }

  const unexpected = extracted
    .map((route) => `${methodOf(route)} ${route.path}`)
    .filter((key) => !matched.has(key));

  return {
    graded,
    unexpected,
    extracted: graded.filter((g) => g.disposition === "extracted").length,
    pathMismatch: graded.filter((g) => g.disposition === "path-mismatch").length,
    missing: graded.filter((g) => g.disposition === "missing").length,
  };
}

/**
 * The gate itself: every reference route must carry a disposition, and every
 * one that is not extracted must name a reason.
 *
 * An unaccounted route — absent with no reason — is the only failing state.
 */
export function everyRouteAccountedFor(grade: RouteGrade): boolean {
  return grade.graded.every(
    (route) => route.disposition === "extracted" || (route.reason !== null && route.reason !== ""),
  );
}
