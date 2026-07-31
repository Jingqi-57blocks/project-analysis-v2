/**
 * Coverage accounting over the denominator buckets.
 *
 * Reuses the applicability buckets (PI-55) rather than inventing a parallel set:
 * every coverage state falls in exactly one bucket, the buckets partition the
 * total, and not-applicable is the only one that leaves the denominator. The
 * tally is a pure function of its input, so recomputing the same states gives
 * the same account.
 */

import {
  bucketOf,
  countsTowardDenominator,
  type CoverageState,
  type DenominatorBucket,
} from "../shared-fact/applicability.js";

const EMPTY_BUCKETS: { readonly [K in DenominatorBucket]: number } = {
  covered: 0,
  empty: 0,
  "not-applicable": 0,
  "capability-gap": 0,
  "evidence-gap": 0,
  failed: 0,
  truncated: 0,
};

export interface CoverageAccount {
  /** All items classified. */
  readonly total: number;
  /** Items inside the denominator (everything but not-applicable). */
  readonly denominator: number;
  /** Items found. */
  readonly covered: number;
  readonly byBucket: { readonly [K in DenominatorBucket]: number };
}

export function account(states: readonly CoverageState[]): CoverageAccount {
  const byBucket: Record<DenominatorBucket, number> = { ...EMPTY_BUCKETS };
  for (const state of states) byBucket[bucketOf(state)] += 1;
  const buckets = Object.keys(byBucket) as DenominatorBucket[];
  const denominator = buckets.filter(countsTowardDenominator).reduce((n, b) => n + byBucket[b], 0);
  return { total: states.length, denominator, covered: byBucket.covered, byBucket };
}

/** covered / denominator, or 1 when nothing is applicable to find (denominator 0). */
export function coverageRatio(a: CoverageAccount): number {
  return a.denominator === 0 ? 1 : a.covered / a.denominator;
}

/** The buckets partition the total, and the denominator excludes exactly not-applicable. */
export function isBalanced(a: CoverageAccount): boolean {
  const sum = Object.values(a.byBucket).reduce((x, y) => x + y, 0);
  return sum === a.total && a.denominator === a.total - a.byBucket["not-applicable"];
}
