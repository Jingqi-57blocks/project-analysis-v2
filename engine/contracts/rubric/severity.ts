/**
 * Severity of an acceptance finding.
 *
 * The kinds are the ways a run can be wrong; the severity is how much each
 * blocks. A precision error (a wrong fact) and a golden-slice truth miss are
 * release blockers; an honest unresolved on a non-critical item is minor. The
 * mapping is fixed here so a gate never has to decide severity subjectively.
 */

export type Severity = "blocker" | "critical" | "major" | "minor";

export type FindingKind =
  | "precision-error"
  | "truth-miss"
  | "unresolved"
  | "provider-failure"
  | "accounting-imbalance"
  | "known-wrong"
  | "silent-omission";

export const FINDING_KINDS: readonly FindingKind[] = [
  "precision-error",
  "truth-miss",
  "unresolved",
  "provider-failure",
  "accounting-imbalance",
  "known-wrong",
  "silent-omission",
];

const SEVERITY: { readonly [K in FindingKind]: Severity } = {
  // A wrong fact and a silently dropped one are the worst: they make the report
  // untrustworthy without announcing it.
  "known-wrong": "blocker",
  "silent-omission": "blocker",
  "precision-error": "blocker",
  // A missed must-find on the golden slice, or a broken provider on a required
  // lane, block; the same off the golden slice is major.
  "truth-miss": "critical",
  "provider-failure": "critical",
  "accounting-imbalance": "critical",
  // An honest unresolved is not a failure by itself — only when it lands on a
  // critical item, which a gate decides by criticality, not here.
  unresolved: "minor",
};

export function severityOf(kind: FindingKind): Severity {
  return SEVERITY[kind];
}

const RANK: { readonly [K in Severity]: number } = { minor: 0, major: 1, critical: 2, blocker: 3 };

/** Whether a finding at `kind` blocks a gate whose bar is `atLeast`. */
export function blocksAt(kind: FindingKind, atLeast: Severity): boolean {
  return RANK[severityOf(kind)] >= RANK[atLeast];
}
