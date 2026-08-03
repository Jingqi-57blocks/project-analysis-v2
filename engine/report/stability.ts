/**
 * The guarantees that replace byte reproducibility.
 *
 * The deterministic pipeline could promise identical bytes from identical input.
 * A model-authored report cannot, so the promise changes shape: every conclusion
 * traces to a fact id, and repeated runs over one fact pack produce claim sets
 * that overlap above a stated threshold. High overlap means the report is driven
 * by the knowledge base; low overlap means it is driven by the model, and the
 * answer then is to tighten the slice, not to loosen the threshold.
 *
 * This module holds the thresholds and the measurement. What tier to run and
 * when a human must read the result are decisions, so they are recorded here as
 * data rather than left in someone's head.
 */

import { claimSetOverlap, type Claim } from "../contracts/claim/index.js";

export const STABILITY_CONTRACT_ID = "report-stability";
export const STABILITY_CONTRACT_VERSION = "1.0.0";

/**
 * The floor, and why it is a floor rather than a preference.
 *
 * The three-model trial gave the same knowledge base and the same spec to three
 * tiers. The lowest did not produce a worse report — it produced an untrue one:
 * a file that does not exist cited under a "verified locations" heading, a
 * computed "no cycles found" turned into "possible circular dependencies", six
 * generic disclaimers in place of 131 real coverage records. That is a
 * difference in kind, not in degree, and no amount of prompting moves it.
 */
export const MINIMUM_TIER = "sonnet";

export const TIER_EVIDENCE = [
  "lowest tier: ~6 min, 13 queries, fabricated a source file and contradicted a computed finding",
  "middle tier: ~16 min, 70 queries, zero fabrication, 8/8 sampled figures exact",
  "highest tier: ~26 min, 198 queries, zero fabrication, found two defects no deriver produces",
] as const;

/**
 * How much two runs over one fact pack must agree.
 *
 * Set at 0.8 rather than something higher because the claim set is expected to
 * move at the margins — a run may or may not raise a minor finding — while the
 * core must not. A drop below this is a signal about the slice, not about the
 * model: it means the pack left enough room for the author to choose what the
 * report is about.
 */
export const CLAIM_OVERLAP_THRESHOLD = 0.8;

export interface StabilityMeasurement {
  readonly runs: number;
  /** Every pairwise overlap, so a single odd run is visible rather than averaged away. */
  readonly pairwise: readonly number[];
  readonly lowest: number;
  readonly mean: number;
  readonly threshold: number;
  readonly meets: boolean;
}

/**
 * Measures agreement across repeated runs.
 *
 * Reports the lowest pair as well as the mean: averaging hides the case where
 * two runs agree closely and a third went its own way, which is exactly the
 * case worth knowing about.
 */
export function measureStability(
  runs: readonly (readonly Claim[])[],
  threshold = CLAIM_OVERLAP_THRESHOLD,
): StabilityMeasurement {
  const pairwise: number[] = [];
  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      pairwise.push(claimSetOverlap(runs[left] ?? [], runs[right] ?? []));
    }
  }
  const lowest = pairwise.length === 0 ? 1 : Math.min(...pairwise);
  const mean = pairwise.length === 0 ? 1 : pairwise.reduce((a, b) => a + b, 0) / pairwise.length;
  return { runs: runs.length, pairwise, lowest, mean, threshold, meets: lowest >= threshold };
}

/**
 * What a person must check that no audit can.
 *
 * The engine can prove a citation exists, that coverage adds up, and that two
 * documents do not contradict each other. It cannot tell whether "this module
 * manages leave approvals" is an accurate summary of what the cited facts mean —
 * only that the facts exist. So the first report for any new project is read by
 * a person once, and the audit holds the line afterwards.
 *
 * This step is not waived on the grounds that the audit passed. A passing audit
 * is what makes the reading worth doing.
 */
export const FIRST_PROOFREAD_CHECKLIST = [
  "Does the opening describe the project a reader would recognise, or a generic system?",
  "Pick five business summaries; do the facts they cite actually support that wording?",
  "Are the module names ones the team would use, or artefacts of the code layout?",
  "Does any chapter read as filler — present, formatted, and saying nothing?",
  "Are the translated terms the ones the business uses, or literal renderings?",
  "Does anything read as advice, intent or consequence rather than current state?",
  "Is every 'unavailable' item one a reader would agree cannot be known from source?",
] as const;

export interface ProofreadRecord {
  readonly snapshotIdentity: string;
  readonly runId: string;
  readonly reviewer: string;
  /** ISO instant; supplied by the caller so this stays deterministic. */
  readonly at: string;
  /** One entry per checklist item, in order. */
  readonly answers: readonly { readonly item: string; readonly accepted: boolean; readonly note?: string }[];
}

export type ProofreadValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

export function validateProofread(record: ProofreadRecord): ProofreadValidation {
  const reasons: string[] = [];
  if (record.reviewer.trim().length === 0) reasons.push("no reviewer recorded");
  if (Number.isNaN(Date.parse(record.at))) reasons.push("no valid review time");
  if (record.answers.length !== FIRST_PROOFREAD_CHECKLIST.length) {
    reasons.push(`${record.answers.length} answers for ${FIRST_PROOFREAD_CHECKLIST.length} checklist items`);
  }
  record.answers.forEach((answer, index) => {
    if (answer.item !== FIRST_PROOFREAD_CHECKLIST[index]) reasons.push(`answer ${index + 1} does not match its item`);
    if (!answer.accepted && (answer.note ?? "").trim().length === 0) {
      reasons.push(`answer ${index + 1} was rejected with no note saying what was wrong`);
    }
  });
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** Whether a project has had the one human reading its first report requires. */
export function needsFirstProofread(
  snapshotIdentity: string,
  records: readonly ProofreadRecord[],
): boolean {
  return !records.some((record) => record.snapshotIdentity === snapshotIdentity);
}
