/**
 * The investigation checklist's identifiers.
 *
 * The checklist itself — what each item hypothesizes and where to search for it —
 * lives in `writing-rules.md`, because it is instruction for the author. What the
 * engine needs is only the set of ids, so that a report missing one is caught: a
 * checklist item silently dropped looks exactly like one that found nothing.
 *
 * The two lists are kept in step by `scripts/verify-contracts.ts`, which reads the
 * table out of the Markdown and compares it to this list.
 */

export const CHECKLIST_IDS: readonly string[] = [
  "literal-secrets",
  "rule-boundary-differs",
  "guard-polarity",
  "literal-identifiers",
  "discarded-errors",
  "uncalled-entries",
  "unauthenticated-entries",
  "shared-storage",
  "deprecated-or-unfinished",
  "feature-switches",
  "external-call-in-transaction",
  "open",
];

/**
 * Items that only mean anything across more than one root.
 *
 * A single-root project cannot have the same rule enforced differently in two
 * parts, or one part reading what another owns. Requiring a verdict there forces
 * the author to either drop the item — which the audit reads as a dropped item —
 * or record "cannot be determined", which means the kind is empty and is a
 * different statement. Neither is true, so the audit stops asking.
 */
export const MULTI_ROOT_CHECKLIST_IDS: readonly string[] = ["rule-boundary-differs", "shared-storage"];

/** The ids a report must carry, given how many roots the snapshot holds. */
export function requiredChecklistIds(rootCount: number): readonly string[] {
  return rootCount > 1 ? CHECKLIST_IDS : CHECKLIST_IDS.filter((id) => !MULTI_ROOT_CHECKLIST_IDS.includes(id));
}
