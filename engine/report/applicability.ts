/**
 * Whether a report section applies to this analysis — included, not-applicable
 * or unknown — with a serializable reason and per-kind evidence.
 *
 * A section reads one or more fact kinds. Each kind resolves to a coverage state
 * (found / not-found / not-applicable / unknown / unsupported / failed /
 * truncated) through the shared classifier, and the section's applicability is
 * the honest aggregate of them. A blocking dimension — broken, cut-off or
 * unsupported — surfaces as `unknown` before the section could be called
 * `not-applicable`, so an absent capability is never reported as "confirmed
 * inapplicable". A section is not-applicable only when every dimension is
 * positively confirmed inapplicable; it is included when a kind has evidence, or
 * when it ran clean over a defined scope and found none with no blocking
 * dimension; and it is unknown whenever the tool could not tell. No section falls
 * through to an implicit default — every input yields exactly one decision.
 *
 * This determines applicability; it does not read source or the knowledge base.
 * The caller supplies each kind's coverage from validated upstream facts, and
 * PI-15 threads the decision into the plan compiler's applicability seam.
 */

import type { FactKind } from "../contracts/shared-fact/families.js";
import {
  type CoverageInput,
  type CoverageState,
  type DenominatorBucket,
  type GapKind,
  type SectionApplicability,
  bucketOf,
  classifyCoverage,
  gapKindOf,
  sectionApplicabilityOf,
} from "../contracts/shared-fact/applicability.js";
import type { SectionRequirement } from "../contracts/report/catalog.js";

/** One fact kind a section reads, with what is known about its coverage. */
export interface KindCoverageInput {
  readonly kind: FactKind;
  readonly coverage: CoverageInput;
}

export interface SectionApplicabilityInput {
  readonly sectionId: string;
  /** `required` means the product contract mandates disclosure even when empty. */
  readonly requirement: SectionRequirement;
  readonly kinds: readonly KindCoverageInput[];
}

export interface KindCoverageEvidence {
  readonly kind: FactKind;
  readonly state: CoverageState;
  /** The gap this kind represents (capability/evidence), or null for a definite answer. */
  readonly gap: GapKind | null;
  /** The denominator bucket this kind lands in. */
  readonly bucket: DenominatorBucket;
  readonly reason: string;
}

export interface SectionApplicabilityDecision {
  readonly sectionId: string;
  readonly applicability: SectionApplicability;
  /** The aggregated slot state behind the three-state verdict. */
  readonly state: CoverageState;
  readonly reason: string;
  readonly evidence: readonly KindCoverageEvidence[];
}

/**
 * The section state is the first of these its kinds exhibit, in this order. It
 * keeps the shared table's blocking-state precedence — failed, truncated,
 * unsupported and unknown all rank above not-applicable, so a missing capability
 * is never laundered into "confirmed inapplicable" — but hoists `found` to the
 * front: at the section level any one kind with evidence is enough to include it.
 */
const SECTION_STATE_PRECEDENCE: readonly CoverageState[] = [
  "found",
  "failed",
  "truncated",
  "unsupported",
  "unknown",
  "not-applicable",
  "not-found",
];

/**
 * The section-level coverage state over its kinds. not-applicable wins only when
 * EVERY kind is not-applicable; a mix of not-applicable and not-found means some
 * dimension has a defined answer to show, so the section is a (partly-empty)
 * not-found — included, not omitted. Empty input fails closed to unknown.
 */
export function aggregateCoverageState(states: readonly CoverageState[]): CoverageState {
  if (states.length === 0) return "unknown";
  const present = new Set(states);
  for (const state of SECTION_STATE_PRECEDENCE) {
    if (state === "not-applicable") {
      if (states.every((s) => s === "not-applicable")) return "not-applicable";
      continue;
    }
    if (present.has(state)) return state;
  }
  return "not-found";
}

function sectionReason(state: CoverageState, requirement: SectionRequirement, witness: FactKind): string {
  switch (state) {
    case "found":
      return `evidence was present for ${witness}`;
    case "failed":
      return `an attempt for ${witness} broke before it could conclude`;
    case "truncated":
      return `a result for ${witness} was cut off before completion`;
    case "unsupported":
      return `no capability to determine ${witness} here`;
    case "unknown":
      return `capability, resolution or evidence is insufficient to establish ${witness}`;
    case "not-applicable":
      return "every dimension of this section is confirmed inapplicable to this project";
    case "not-found":
      return requirement === "required"
        ? "required by the product contract; ran over a defined scope, found none, disclosed as empty"
        : "ran over a defined scope and found none";
  }
}

/**
 * Determine one section's applicability. Every kind is classified, the states are
 * aggregated, and the verdict is mapped to the reader-facing three-state with a
 * reason naming the deciding kind and the per-kind evidence carried through.
 */
export function determineSectionApplicability(
  input: SectionApplicabilityInput,
): SectionApplicabilityDecision {
  const evidence: KindCoverageEvidence[] = input.kinds.map((k) => {
    const { state, reason } = classifyCoverage(k.coverage);
    return { kind: k.kind, state, gap: gapKindOf(state), bucket: bucketOf(state), reason };
  });

  if (evidence.length === 0) {
    return {
      sectionId: input.sectionId,
      applicability: "unknown",
      state: "unknown",
      reason: "no evidence kinds are declared for this section, so applicability cannot be established",
      evidence,
    };
  }

  const state = aggregateCoverageState(evidence.map((e) => e.state));
  // The deciding kind: the first whose own state is the aggregate (for a unanimous
  // verdict, the first kind). Deterministic — kinds keep their declared order.
  const witness = evidence.find((e) => e.state === state)?.kind ?? evidence[0]!.kind;
  return {
    sectionId: input.sectionId,
    applicability: sectionApplicabilityOf(state),
    state,
    reason: sectionReason(state, input.requirement, witness),
    evidence,
  };
}

/**
 * Determine applicability for a set of sections. Every section yields a decision,
 * so nothing lands in an implicit default state.
 */
export function determineSectionApplicabilities(
  inputs: readonly SectionApplicabilityInput[],
): readonly SectionApplicabilityDecision[] {
  return inputs.map(determineSectionApplicability);
}
