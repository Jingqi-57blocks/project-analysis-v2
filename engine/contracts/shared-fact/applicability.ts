/**
 * Why a fact or section is present or absent — as one mutually-exclusive,
 * machine-readable code with a readable reason.
 *
 * "Nothing found", "confirmed not applicable" and "the tool cannot tell" are
 * different results. Collapsing them either shrinks coverage below the truth
 * (an unknown counted as a genuine empty) or fabricates a clean report (an
 * unsupported capability counted as not-applicable). The classifier below makes
 * the illegal collapses unreachable rather than merely discouraged.
 *
 * These are the consumer-side accounting terms. They relate to, but do not
 * duplicate, a provider's own capability declaration (`SupportLevel`,
 * `CapabilityGap` in engine/structural/provider.ts): a provider declaring
 * `none` for a kind is what produces the `unsupported` state here.
 */

/** Mutually exclusive. Every fact or section slot resolves to exactly one. */
export type CoverageState =
  /** The provider ran over a defined scope and evidence was present. */
  | "found"
  /** The provider ran over a defined scope and there is genuinely none. */
  | "not-found"
  /** Positively confirmed that this scope cannot have the thing. */
  | "not-applicable"
  /** Capability, resolution or evidence is insufficient to tell. */
  | "unknown"
  /** No capability to determine this here. */
  | "unsupported"
  /** An attempt broke before it could conclude. */
  | "failed"
  /** A result was cut off before completion. */
  | "truncated";

export const COVERAGE_STATES: readonly CoverageState[] = [
  "found",
  "not-found",
  "not-applicable",
  "unknown",
  "unsupported",
  "failed",
  "truncated",
];

/**
 * The report-facing three-state, as the dual-report content contract uses it.
 * Narrower than CoverageState: several evidence states all read to a reader as
 * "we could not establish this".
 */
export type SectionApplicability = "included" | "not-applicable" | "unknown";

/** A gap is either missing capability or missing evidence — never a silent empty. */
export type GapKind = "capability" | "evidence";

/** Accounting buckets over a denominator. Mutually exclusive; not-applicable is
 *  the only one excluded from the denominator (see countsTowardDenominator). */
export type DenominatorBucket =
  | "covered"
  | "empty"
  | "not-applicable"
  | "capability-gap"
  | "evidence-gap"
  | "failed"
  | "truncated";

/**
 * What is known when classifying one slot. `failed` and `truncated` are attempt
 * outcomes and take precedence: a broken or cut-off attempt is never reinterpreted
 * as a clean result.
 */
export interface CoverageInput {
  /** A capability exists to determine this here (some provider declares support). */
  readonly capable: boolean;
  /** The provider actually executed to completion for this slot. */
  readonly providerRan: boolean;
  /** The scope and denominator for this slot are well-defined. */
  readonly scopeDefined: boolean;
  /** Any evidence was found. */
  readonly evidencePresent: boolean;
  /** Positively confirmed inapplicable (not merely absent). */
  readonly notApplicableConfirmed: boolean;
  /** An attempt broke. */
  readonly failed: boolean;
  /** A result was cut off before completion. */
  readonly truncated: boolean;
  /** Inputs conflict or are missing — forces a fail-closed unknown. */
  readonly conflict: boolean;
}

export interface CoverageClassification {
  readonly state: CoverageState;
  readonly reason: string;
}

/**
 * The decision table, evaluated top to bottom; the first matching row wins.
 * Ordering is the contract: `failed`, `truncated` and `unsupported` are tested
 * before `not-applicable`, so an attempt that broke or a capability that is
 * missing can never be recorded as "confirmed not applicable". `not-found` is
 * reached only after capability, a completed run, a defined scope and the
 * absence of conflict are all established — a genuine empty, never a guess.
 */
export const COVERAGE_DECISION_TABLE: readonly {
  readonly when: (input: CoverageInput) => boolean;
  readonly state: CoverageState;
  readonly reason: string;
}[] = [
  { when: (i) => i.failed, state: "failed", reason: "an attempt broke before it could conclude" },
  { when: (i) => i.truncated, state: "truncated", reason: "a result was cut off before completion" },
  { when: (i) => !i.capable, state: "unsupported", reason: "no capability to determine this here" },
  {
    when: (i) => i.conflict || !i.providerRan || !i.scopeDefined,
    state: "unknown",
    reason: "capability, resolution or evidence is insufficient to tell",
  },
  {
    when: (i) => i.notApplicableConfirmed,
    state: "not-applicable",
    reason: "confirmed this scope cannot have the thing",
  },
  { when: (i) => i.evidencePresent, state: "found", reason: "evidence was present over a defined scope" },
  { when: () => true, state: "not-found", reason: "ran over a defined scope and found none" },
];

/** Classifies one slot. Fails closed to `unknown`; never coerces to a clean result. */
export function classifyCoverage(input: CoverageInput): CoverageClassification {
  for (const row of COVERAGE_DECISION_TABLE) {
    if (row.when(input)) return { state: row.state, reason: row.reason };
  }
  // Unreachable: the final row always matches. Kept explicit so a future edit
  // that removes it fails closed rather than returning undefined.
  return { state: "unknown", reason: "no decision row matched" };
}

const SECTION_APPLICABILITY: { readonly [K in CoverageState]: SectionApplicability } = {
  found: "included",
  // A defined, completed "none" is a section a reader can be shown ("none found"),
  // not an absence of knowledge.
  "not-found": "included",
  "not-applicable": "not-applicable",
  unknown: "unknown",
  unsupported: "unknown",
  failed: "unknown",
  truncated: "unknown",
};

export function sectionApplicabilityOf(state: CoverageState): SectionApplicability {
  return SECTION_APPLICABILITY[state];
}

const GAP_KIND: { readonly [K in CoverageState]: GapKind | null } = {
  found: null,
  "not-found": null,
  "not-applicable": null,
  unsupported: "capability",
  unknown: "evidence",
  failed: "evidence",
  truncated: "evidence",
};

/** The gap a state represents, or null when the state is a definite answer. */
export function gapKindOf(state: CoverageState): GapKind | null {
  return GAP_KIND[state];
}

const BUCKET: { readonly [K in CoverageState]: DenominatorBucket } = {
  found: "covered",
  "not-found": "empty",
  "not-applicable": "not-applicable",
  unsupported: "capability-gap",
  unknown: "evidence-gap",
  failed: "failed",
  truncated: "truncated",
};

export function bucketOf(state: CoverageState): DenominatorBucket {
  return BUCKET[state];
}

/** not-applicable is confirmed outside the scope, so it leaves the denominator;
 *  every other bucket stays in it. */
export function countsTowardDenominator(bucket: DenominatorBucket): boolean {
  return bucket !== "not-applicable";
}
