/**
 * The families a fact can belong to. Closed, like resolution: this is our
 * taxonomy of evidence, not the language's — an unfamiliar project contributes
 * facts, never a fifth family.
 */
export type FactFamily = "structural" | "behavioral" | "diagnostic" | "coverage";

export const FACT_FAMILIES: readonly FactFamily[] = [
  "structural",
  "behavioral",
  "diagnostic",
  "coverage",
];

/**
 * A fact's kind within its family — `route`, `condition`, `state-transition`.
 * Open on purpose: kinds are domain- and language-driven, so this stays a
 * documented string union rather than a closed set that forces a wrong label.
 */
export type FactKind = string;
