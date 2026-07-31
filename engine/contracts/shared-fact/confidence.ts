/**
 * Confidence: its levels, its basis, and how it aggregates.
 *
 * The `Confidence` type itself lives in provenance.ts, where it qualifies a
 * resolved or inferred fact. This module fixes the two things a level alone
 * cannot say: why it was assigned, and the one direction it may move when
 * several are combined.
 */

import type { Confidence } from "./provenance.js";

export const CONFIDENCE_LEVELS: readonly Confidence[] = ["high", "medium", "low"];

/**
 * Why a confidence was assigned, so a level is never a bare grade with no
 * basis. Open: a provider may cite its own reason (a matched declaration, a
 * heuristic, a cross-reference).
 */
export type ConfidenceBasis = string;

const RANK: { readonly [K in Confidence]: number } = { low: 0, medium: 1, high: 2 };

/**
 * Confidence only weakens under aggregation. A conclusion drawn through a chain
 * is at most as strong as its weakest link, and independent low-confidence
 * signals never add up to a high-confidence answer — the opposite would let a
 * report launder guesses into certainty. Empty aggregates to null: no basis.
 */
export function aggregateConfidence(confidences: readonly Confidence[]): Confidence | null {
  let weakest: Confidence | null = null;
  for (const c of confidences) {
    if (weakest === null || RANK[c] < RANK[weakest]) weakest = c;
  }
  return weakest;
}
