/**
 * The three-column glossary.
 *
 * Business vocabulary in code is usually written in the source language. A reader
 * of a Spanish report who sees "solicitud de permiso" can map it neither back to
 * the code nor across to a team working in the source language. Losing either
 * link makes the report unusable for the work it was written for, so all three
 * layers are kept: the identifier, the business term in the source language, and
 * the rendering in the target language.
 *
 * The body of the report uses the target language. The glossary is where the
 * other two survive.
 */

export interface GlossaryEntry {
  /** As it appears in code. */
  readonly identifier: string;
  /** The business term, in the language the code was written in. */
  readonly sourceName: string;
  /** The same term in the report's target language. */
  readonly targetName: string;
  /** Expansion, when the identifier or source name is an abbreviation. */
  readonly expansion?: string;
}

export interface Glossary {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly entries: readonly GlossaryEntry[];
}

export type GlossaryValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Whether a term reads as an abbreviation.
 *
 * Two shapes, both independent of any particular language or project: all-caps
 * short tokens, and tokens with the vowels dropped. The check exists so an
 * abbreviation cannot be published without its expansion — a reader who does not
 * already know it has nowhere else to look.
 */
export function looksAbbreviated(term: string): boolean {
  if (term.length === 0 || term.length > 8) return false;
  if (!/^[A-Za-z]+$/.test(term)) return false;
  if (term === term.toUpperCase() && term.length >= 2) return true;
  return !/[aeiouAEIOU]/.test(term) && term.length >= 3;
}

export function validateGlossary(glossary: Glossary): GlossaryValidation {
  const reasons: string[] = [];
  if (glossary.sourceLanguage.length === 0) reasons.push("source language is not declared");
  if (glossary.targetLanguage.length === 0) reasons.push("target language is not declared");
  const seen = new Set<string>();
  for (const entry of glossary.entries) {
    const where = entry.identifier.length > 0 ? entry.identifier : "(no identifier)";
    if (entry.identifier.trim().length === 0) reasons.push("an entry has no code identifier");
    if (entry.sourceName.trim().length === 0) reasons.push(`${where}: no source-language business name`);
    if (entry.targetName.trim().length === 0) reasons.push(`${where}: no target-language rendering`);
    if (seen.has(entry.identifier)) reasons.push(`${where}: listed more than once`);
    seen.add(entry.identifier);
    if (looksAbbreviated(entry.identifier) && (entry.expansion ?? "").trim().length === 0) {
      reasons.push(`${where}: reads as an abbreviation and has no expansion`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Identifiers a report used that the glossary never explains.
 *
 * The report body is required to use readable wording, so any identifier that
 * survives into it must be anchored here or the reader is left with a raw table
 * or function name.
 */
export function unexplainedIdentifiers(glossary: Glossary, usedIdentifiers: readonly string[]): readonly string[] {
  const known = new Set(glossary.entries.map((entry) => entry.identifier));
  return [...new Set(usedIdentifiers.filter((identifier) => !known.has(identifier)))].sort();
}
