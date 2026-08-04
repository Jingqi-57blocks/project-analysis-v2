/**
 * The investigation checklist's identifiers.
 *
 * The checklist itself — what each item hypothesizes and where to search for it —
 * lives in `writing-rules.md`, because it is instruction for the author. What the
 * engine needs is only the set of ids, so that a report missing one is caught: a
 * checklist item silently dropped looks exactly like one that found nothing.
 *
 * The two lists are kept in step by a test that reads the Markdown table.
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
