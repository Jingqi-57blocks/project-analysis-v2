/**
 * The fixed words a report is built from — its frame, not its facts.
 *
 * Headings, table columns, the labels on a diagram: text the engine writes
 * around the data. The data itself — a table name, a host, a number — is never
 * here, so this can be translated without a model ever seeing a fact.
 *
 * Only English lives in code. Any other language is supplied at export time as
 * a translation of these same keys (see `frame-translation` in prepare), so a
 * new language is a filled-in task, never a dictionary added here.
 */

/** Frame keys to their English text. `{0}`, `{1}` are filled with facts later. */
export type Glossary = Readonly<Record<string, string>>;

export const FRAME_EN: Glossary = {
  contents: "Contents",
  "nothing-to-show": "_Nothing to show here._",
  "no-limits": "This run recorded no limits on what it could read, which is itself worth doubting.",

  "col-repository": "Repository",
  "col-does": "What it does",
  "col-languages": "Languages",
  "col-files-read": "Code files read",
  "col-endpoints-traced": "Endpoints traced",
  "col-screens": "Screens",
  "col-tests": "Tests named",
  "col-fact": "Fact",
  "col-total": "Total",
  "col-capability": "Capability",
  "col-flows-traced": "Flows followed to the end",
  "col-steps-traced": "Steps established",
  "col-flow": "Flow",
  "col-stops-at": "Where the trace stops",

  "role-serves-http": "serves an API",
  "role-shows-screens": "shows screens",
  "role-stores-data": "stores data",
  "role-runs-scheduled": "runs work on a schedule",
  "role-sends-notifications": "sends notifications",
  "role-none": "no entry point of any kind was found in it",

  "of-total": "{0} of {1}",
  "of-total-percent": "{0} of {1} ({2}%)",
  "stack-line": "**{0}** — {1}",
  "stack-and-more": "{0} direct dependencies in all, {1} of them pinned to an exact version",
  "range-marked":
    "_A version marked ✱ is what the manifest declares as acceptable — a range, or a minimum. No lockfile in this run settled which version is actually installed._",
  "not-looked-for": "**Not looked for in this run.** Nothing below says whether the project has any:",
  "looked-found-none": "**Looked for and not found:**",
  "dimensions-note":
    "_Counts are distinct records. A fact two readers agree on is one record, not two._",
  "no-flows-traced": "_No flow of this capability was followed end to end; the table says where each stops._",

  "col-from": "From",
  "col-to": "To",
  "col-kind": "Kind",
  "col-detail": "Detail",
  "col-about": "About",
  "col-cannot-establish": "What this analysis could not establish",
  "col-reader": "Reader",
  "col-where": "Where",
  "col-went-wrong": "What went wrong",

  "reached-from": "reached from {0}",
  "address-left-out":
    "_{0} further address was left out: development addresses and documentation links, which are written in the code but are not systems this one talks to._",
  "addresses-left-out":
    "_{0} further addresses were left out: development addresses and documentation links, which are written in the code but are not systems this one talks to._",
  "keeps-records": "It keeps {0} kinds of record. Among them: {1}.",
  "full-schema-note": "_The full schema, with every column, is in the JSON export._",
  "and-more": "and {0} more",

  while: " — while {0}",
  "made-in-places": " — the same choice is made in {0} places",
  "anything-else": "anything else",
  "stops-here": "stops here",
  "handled-unknown": "handled — what it does was not established",
  uses: "uses {0}",
  "stops-having-used": "stops, having used {0}",

  "own-handling": "Its own handling was observed to read or write: {0}.",
  "shared-tables": "Records this capability shares with others — a change to one is felt in both: {0}.",
  "further-nearby":
    "A further {0} kinds of record were touched elsewhere in the same code, so they may belong to this capability or to something beside it: {1}.",
};

/** A heading a template declares becomes a frame key, so it translates too. */
export function headingKey(heading: string): string {
  return `heading:${heading}`;
}

/**
 * The frame for a report: English, plus every heading its template declares.
 *
 * Headings are added here rather than hard-coded so a template written for a
 * new document translates with no change to this file.
 */
export function frameFor(headings: readonly string[]): Glossary {
  const frame: Record<string, string> = { ...FRAME_EN };
  for (const heading of headings) frame[headingKey(heading)] = heading;
  return frame;
}

/**
 * A translated frame over the English one.
 *
 * Anything the translation is missing falls back to English rather than to a
 * blank — a half-answered task still produces a readable report.
 */
export function applyGlossary(base: Glossary, translation: Glossary): Glossary {
  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(translation)) {
    if (typeof value === "string" && value.trim() !== "") merged[key] = value;
  }
  return merged;
}

/** A frame string with its `{n}` slots filled. Missing keys show as `[key]`. */
export function t(frame: Glossary, key: string, ...args: (string | number)[]): string {
  const template = frame[key];
  if (template === undefined) return `[${key}]`;
  return template.replace(/\{(\d+)\}/g, (_, n: string) => String(args[Number(n)] ?? ""));
}

/** A template heading in the report's language, unchanged if untranslated. */
export function heading(frame: Glossary, english: string): string {
  return frame[headingKey(english)] ?? english;
}

/** English needs no translation task; anything else does. */
export function needsTranslation(language: string | undefined): boolean {
  if (language === undefined) return false;
  const tag = language.toLowerCase().trim();
  return tag !== "" && tag !== "en" && !tag.startsWith("en-") && tag !== "english";
}
