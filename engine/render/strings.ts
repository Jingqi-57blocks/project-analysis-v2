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
  "col-id": "ID",
  // Not "Tables": the attribution is file-scoped, so the cell holds every table
  // touched anywhere in the handler's file. WCP's Title capability has one
  // endpoint reading `wcp_title` alone, and eleven tables in this cell, because
  // its handler shares a file with the rest of the user service.
  "col-tables-touched": "Tables its files touch",
  "tables-in-package": "elsewhere in its package: {0}",
  "tables-not-counted": "and more, uncounted",
  "col-when": "When",
  // Not "First seen": the cell lists every file in this repository that states the
  // rule, and a first is walk order rather than a fact about the code.
  "col-enforced-in": "Enforced in",
  "and-files": "{0} and {1} more file(s)",
  "also-in-other-repositories": "also enforced in {0} file(s) in other repositories",
  "col-endpoints": "Endpoints",
  "col-area": "Area",
  "col-pages": "Pages",
  "col-addresses": "Addresses",
  "col-rejects-with": "Rejects with",
  "col-stated-as": "Stated as",
  "message-kind-stated": "a message in the code",
  "message-kind-error-code": "a named error constant",
  "exit-throw": "thrown",
  "exit-return": "returned",
  "exit-return-and-throw": "thrown in one place and returned in another",
  // Every quantity here is measured at render time. Both halves used to be
  // asserted: "the ones with no gap in them" was only a preference in the sort, and
  // "most have at least one such step" was counted once, by hand, against one
  // target.
  "prd-flows-lead":
    "{0} traced flows, at most two for each of the capabilities with the most of " +
    "them, chosen as the clearest of each: a trace with no gap in it before one with " +
    "a gap, and among those the one resting least on evidence from the handler's " +
    "package rather than the handler itself. {1} {2} of those drawn carry at least " +
    "one step observed only in the package, and every edge drawn from one says so.",
  "prd-flows-all-whole": "None of them has a gap.",
  "prd-flows-some-partial": "{0} of them still has a gap, no flow of that capability being whole.",
  "prd-flow-whole": "{0} flow(s), every step established",
  "prd-flow-partial": "{0} of {1} flow(s) have a step that could not be resolved",
  "prd-flow-entry": "Entry point `{0}`",
  // Says which flows were drawn rather than claiming anything about the rest: an
  // earlier line said every undrawn flow was reachable from an endpoint listed
  // above, and 261 of them start at an endpoint this document never prints.
  // Not "the ones whose steps were established in the handler itself": 14 of the
  // 16 drawn carry a step observed only in the handler's package, and the diagrams
  // three lines above say so on every one of those edges.
  // Both keys, not the second alone: four of the eight drawn capabilities have an
  // undrawn flow with no package-scoped step at all, undrawn because it has a gap.
  "prd-flows-left-out":
    "{0} of {1} traced flow(s) are not drawn: at most {2} per capability appear here, " +
    "the ones with no gap in them, and among those the ones resting least on " +
    "evidence from outside the handler.",
  "prd-flows-capabilities-left-out":
    "{0} of the {1} capabilities with a traced flow have no diagram here: the ones " +
    "with the most flows are drawn. The rest are traced in the knowledge base and " +
    "can be rendered per capability.",
  "prd-flows-no-entry":
    "{0} of {1} capabilities have no diagram because no entry point was attributed to " +
    "them at all — they were detected from the system's vocabulary, not from a route.",
  "prd-flows-no-chain":
    "{0} of {1} capabilities have an entry point but no flow traced from it.",
  "prd-no-flows":
    "No flow was traced end to end, so this section is empty rather than guessed. " +
    "Entry points and the tables they reach are listed in their own sections.",
  "prd-features-lead":
    "Each capability below was detected from the system's own vocabulary — the words its routes, folders and tables use — and owns the endpoints named beside it. The tables column is wider than the capability: a table is listed when it is touched anywhere in the file handling one of these endpoints, and a second list gives the tables touched elsewhere in that file's package. Read either as where to look rather than as what this capability stores; a dash means no table was attributed at either scope. A row ending \"and more, uncounted\" means at least one trace of this capability reached more tables than it names; some of those may still appear in the row through another of its endpoints, and how many do not is beyond what this can state.",
  "prd-orphan-endpoints":
    "{0} of {1} endpoints belong to no capability above: the system's vocabulary gave " +
    "no term to file them under. They are part of the surface a rebuild has to " +
    "cover, so they are named here rather than left out.",
  "prd-features-note":
    "Identifiers are assigned by this document, not carried in the code, so they are stable for one run rather than across the system's history. No row carries a priority: nothing in a codebase records which capability mattered more, and a recovered specification that invented a ranking would be putting a product decision in a reader's mouth.",
  "prd-no-features": "No capability was detected from this system's vocabulary.",
  "prd-pages-lead":
    "{0} addresses were read from the application's own route table, grouped by the area each belongs to. Hierarchy is the paths' own — a nested address is a nested page — and a parameter appears as the code writes it.",
  "prd-pages-note":
    "No page here is joined to the component that draws it, so what a page is *for* — its goal, its main action, what it must not show — is absent by necessity rather than oversight. An address assembled at run time is not read at all and so cannot appear.",
  "prd-no-pages": "This system serves no client-side route table that could be read as a page map.",
  "prd-validation-lead":
    "What the system refuses, quoted in the words it refuses with. The message is the rule as the code states it, not an interpretation of what it means. Read the last column before relying on a row: a thrown message is a refusal, while a returned one may be a refusal — a rejection in Express or Go states its message by building a response body — or may be a value the branch produces, such as a subject line or a label. This reader cannot tell those apart, so it says which the branch did and leaves the judgement where the evidence is.",
  "prd-validation-note":
    "One row per message per repository: two gates stating the same message in one codebase collapse into one row, and a message enforced in two codebases appears under each, because the conditions are rarely the same rule twice. A rule expressed through control flow rather than a rejection, or one whose message lives in a catalogue this run did not read, does not appear at all; a message a component states in its props is read as a rejection even where it is only a label, as is a value a branch returns; and a message built from a template is quoted as the first run of its text that reads like a sentence, which may begin or end at an interpolation.",
  "prd-no-validation": "No rejection with a stated message was read from this system.",
  "prd-absent-lead":
    "This specification was recovered from source. It states in mechanical detail what the system does, and the following cannot be recovered from code by any means — they are absent here because no codebase records them, not because the recovery fell short:",
  // Not "no statement of purpose survives": the repositories' own documentation
  // often states one, this engine reads it, and the opening section reports it.
  // What no codebase holds is why any of it was worth building.
  "prd-absent-goal":
    "**What the product is for.** Source states what the system does, never why it " +
    "was worth doing: no problem, no intended outcome, no argument for one design " +
    "over another. Where a repository's own documentation describes itself, the " +
    "opening section reports what it says — a description is not a statement of intent.",
  "prd-absent-users": "**Who uses it, and what for.** What the code checks before it acts can be recovered; who the people behind those checks are, and what they are trying to achieve, cannot.",
  "prd-absent-metrics": "**What success means.** No target, threshold or measure of success exists in code.",
  // Not "stated at equal weight": the capabilities table is ordered by endpoint
  // count and numbered from it, so F001 reads as first for a reason.
  "prd-absent-priority":
    "**What matters most.** No ranking by importance survives. Where this document " +
    "orders capabilities it orders them by surface area — how many endpoints each " +
    "answers — which is a measurement rather than a priority.",
  "prd-absent-risks": "**What the team was worried about.** Risks and assumptions are decisions and conversations, not artefacts.",
  "prd-absent-scope":
    "One section inverts. Read forwards, *out of scope* is a decision someone made; read backwards, everything in the code is in scope by definition. So the honest content of that section is not what anyone chose to leave out but what this analysis could not read — stated below and throughout, rather than omitted.",
  "prd-absent-counts":
    "Of the files this analysis read, {0} yielded nothing about behaviour and a further {1} yielded nothing at all. Both are listed later in this document, largest first, with the remainder counted rather than named — because a specification quietly smaller than its system is more dangerous than one visibly incomplete.",
  "prd-absent-notes":
    "{0} standing limits of the readers that produced this document are listed with it. They are conditions on every statement here, and worth reading before relying on any single one.",
  "col-file": "File",
  kib: "{0} KB",
  bytes: "{0} bytes",
  "col-size": "Size",
  "silent-lead":
    "Nothing about behaviour was extracted from these files — no route, table access, rule, decision, scheduled task or entity. That is a statement about this analysis, not about the files: several of them plainly do contain such things, and one of them being large is the clearest sign of what a report drawn only from what was found would leave out. Largest first, because that is where to start looking.",
  "unread-lead":
    "And nothing at all was extracted from these — not a symbol, not an import. Whether they hold anything about behaviour is unknown rather than known to be absent, which is the stronger statement of the two: a model file declaring a table appears here because no reader could read it, not because it says nothing.",
  "silent-note":
    "A file counts as read for the coverage fraction when anything at all came out of it — a symbol, an import, a comment — so a repository can be read in full and still be listed here in quantity. Neither group is a claim that a file is empty. It is where this report stopped, so a gap is visible rather than silent.",
  "silent-none": "Every file this capability owns yielded something about behaviour.",
  "silent-none-repo": "Every file read yielded something about behaviour.",
  "silent-in": "In {0}:",
  "col-stops-at": "Where the trace stops",

  "role-serves-http": "serves an API",
  "role-shows-screens": "shows screens",
  "role-stores-data": "stores data",
  "role-runs-scheduled": "runs work on a schedule",
  "role-sends-notifications": "sends notifications",
  "role-none": "no entry point of any kind was found in it",

  "of-total": "{0} of {1}",
  "of-total-percent": "{0} of {1} ({2}%)",
  "col-runtime": "Runtime",
  "col-built-with": "Most-used libraries",
  "col-dependencies": "Dependencies pinned",
  "stack-note":
    "_The {0} libraries each repository imports in the most files, with the version installed. They are the ones its code leans on, which is not the same as the ones an architect would name — nothing in the code says which of its packages is a framework and which is a helper._",
  "range-marked":
    "_A version marked ✱ is what the manifest declares as acceptable — a range, or a minimum. No lockfile in this run settled which version is actually installed._",
  /** What separates items joined into one cell or sentence. */
  join: "; ",
  "all-reports": "All reports",
  "kind-overview": "System overview",
  "kind-capability": "Capability report",
  "kind-coverage": "Analysis coverage",
  "all-reports-lead": "The reports produced from this analysis.",
  "col-no-caller": "No caller found",
  "no-caller-note":
    "_\"No caller found\" means the endpoint's own code was followed but nothing in the workspace was seen to ask for it — ordinary for a report, an export, or anything a system outside this workspace calls._",
  "migrations-read":
    "_Beside its code, **{0}** holds schema-migration scripts: {1} of them yielded a fact. They declare a schema rather than behaviour, so they are counted apart._",
  "not-looked-for": "**Not looked for in this run.** Nothing below says whether the project has any:",
  "looked-found-none": "**Looked for and not found:**",
  "empty-in-some-root":
    "**Found elsewhere, but not in every repository.** Where a reader said why, it says so here:",
  "dimensions-note":
    "_Counts are distinct records. A fact two readers agree on is one record, not two._",
  "no-flows-traced": "_No flow of this capability was followed end to end; the table says where each stops._",

  "stop-no-caller":
    "nothing in the analyzed code was seen to call this endpoint; it may be called from outside the workspace",
  "stop-inline-handler":
    "the endpoint is registered with an inline function, which has no name to follow",
  "stop-unresolved-handler":
    "the code behind the endpoint could not be identified, so what it touches was not followed",
  "stop-ambiguous-handler":
    "the endpoint names a handler that matches more than one function, so none was chosen",
  "stop-truncated": "more of this step was established than is shown here",
  "stop-no-data-access":
    "no data access was observed in the handler's own code; access from elsewhere is not followed",

  "col-from": "From",
  "col-to": "To",
  "col-kind": "Kind",
  "col-detail": "Detail",
  "col-about": "About",
  "every-root": "all parts",
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

/**
 * Why a trace stopped, in the report's language.
 *
 * These sentences are the engine's own words, written when a flow was
 * assembled and stored with it as facts. Stored English text rendered into a
 * Chinese report left the one column a reader consults about trust in a
 * language they may not read, so each is matched to a frame key here by a
 * stable fragment of itself.
 *
 * A reason nothing matches is shown as stored. That is the honest fallback: an
 * untranslated sentence a reader can still act on beats a blank cell.
 */
const STOP_REASONS: readonly (readonly [string, string])[] = [
  ["no call in the analyzed roots resolves", "stop-no-caller"],
  ["inline function", "stop-inline-handler"],
  ["handler was not resolved", "stop-unresolved-handler"],
  ["no data access was observed", "stop-no-data-access"],
  // As the linking layer writes it: `2 symbols named "Apply" match; refusing to
  // pick one`. The earlier marker here matched only a coverage note's wording,
  // so the reason a reader actually meets stayed English.
  ["refusing to pick one", "stop-ambiguous-handler"],
];

/** One stored reason in the report's language, or as stored if it is unknown. */
export function stopReason(frame: Glossary, stored: string): string {
  const matched = STOP_REASONS.find(([marker]) => stored.includes(marker));
  return matched === undefined ? stored : t(frame, matched[1]);
}

/** A heading a template declares becomes a frame key, so it translates too. */
export function headingKey(heading: string): string {
  return `heading:${heading}`;
}

/**
 * A sentence this analysis wrote about itself — a limit, a reader's stated
 * reason, a note about what could not be established.
 *
 * These are stored with the facts because a limitation only its author can see
 * is a limitation nobody sees, and they are composed with counts, so they
 * cannot be fixed keys. They are still the engine's words rather than the
 * project's, which is what makes them translatable: the whole "Analysis
 * Limitations" section of a Chinese report was English until they were.
 *
 * Keyed by the English text itself, so a note that changes wording gets a new
 * key and falls back to English rather than showing an old translation of
 * something else.
 */
export function noteKey(text: string): string {
  return `note:${text}`;
}

/** One stored note in the report's language, or as stored if untranslated. */
export function note(frame: Glossary, text: string): string {
  return frame[noteKey(text)] ?? text;
}

/**
 * A failure's reason without the path it opens with.
 *
 * Most read `"/leaves" registers a mount…` — the path is already the row's
 * location, and dropping it is what lets forty near-identical failures group
 * into one line. Shared with whoever collects these for translation, because a
 * translation keyed on the full sentence would never match the shortened one a
 * reader is shown.
 */
export function reasonWithoutPath(reason: string): string {
  return reason.replace(/^"[^"]*"\s*/, "").trim();
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
