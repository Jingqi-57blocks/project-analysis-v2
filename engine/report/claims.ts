/**
 * The report's own account of what each statement rests on.
 *
 * The checklist proves the investigation happened. It proves nothing about the
 * body: its identities are the only ones the audit ever resolved, so a report
 * whose prose was invented outright and whose `checklist.json` was correct
 * passed. That is the one shape of fabrication the audit existed to catch.
 *
 * So the body declares its evidence too, in `claims.json`, and the audit checks
 * the declaration both ways — every declared identity exists in the snapshot and
 * appears in the chapter that claims it, and every identity appearing in the body
 * is declared by some claim. Neither direction alone is enough: the first lets a
 * chapter cite rows it never mentions, the second lets it mention rows nothing
 * accounts for.
 *
 * What this cannot do is decide whether the prose follows from the rows. Nothing
 * mechanical can. It removes the case where the prose rests on nothing at all.
 */

import type { Store } from "../store/types.js";

/** How a statement is grounded. Semantic tokens; the author renders them per language. */
export const MARKERS = new Set(["fact", "verified", "inferred", "unavailable"]);

export interface Claim {
  readonly id: string;
  /** The chapter this claim belongs to, as its 1-based position among `##` headings. */
  readonly section: number;
  readonly marker: string;
  readonly evidenceIds: readonly string[];
  /** Why the base cannot answer. Required of `unavailable`, meaningless otherwise. */
  readonly reason?: string;
}

export class ClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsError";
  }
}

/**
 * Parses `claims.json`.
 *
 * Malformed entries are refused rather than skipped. A silently dropped claim is
 * an undeclared identity in the body, which the coverage check would then report
 * against the chapter rather than against the claim that failed to parse — the
 * finding would be real and the explanation misleading.
 */
export function parseClaims(source: string): readonly Claim[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new ClaimsError(`claims.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { claims?: unknown }).claims)) {
    throw new ClaimsError('claims.json must be an object with a "claims" array');
  }

  return (raw as { claims: readonly unknown[] }).claims.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new ClaimsError(`claims[${index}] is not an object`);
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const section = record["section"];
    const marker = record["marker"];
    if (typeof id !== "string" || id === "") throw new ClaimsError(`claims[${index}]: "id" must be a non-empty string`);
    if (typeof section !== "number" || !Number.isInteger(section) || section < 1) {
      throw new ClaimsError(`${id}: "section" must be the chapter's 1-based position`);
    }
    if (typeof marker !== "string") throw new ClaimsError(`${id}: "marker" must be a string`);
    const evidenceIds = Array.isArray(record["evidenceIds"])
      ? (record["evidenceIds"] as readonly unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    const reason = typeof record["reason"] === "string" && record["reason"].trim() !== "" ? record["reason"] : undefined;
    return { id, section, marker, evidenceIds, ...(reason === undefined ? {} : { reason }) };
  });
}

/**
 * The report's chapters, in the order they appear.
 *
 * Chapters are identified by position, not by the number written in the heading.
 * A report is written in whatever language was asked for, and its headings number
 * themselves in that language's conventions — matching on the text would make the
 * check depend on which language a run chose, which is the one thing every check
 * here is required not to do.
 */
export function reportSections(report: string): readonly string[] {
  const sections: string[][] = [];
  let fenced = false;

  for (const line of report.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    // A heading inside a fenced block is sample text, not a chapter.
    if (!fenced && /^##[^#]\s*\S/.test(line)) {
      sections.push([line]);
      continue;
    }
    sections[sections.length - 1]?.push(line);
  }

  return sections.map((lines) => lines.join("\n"));
}

/**
 * The identity namespaces this snapshot actually uses.
 *
 * Read from the base rather than described, because "what an identity looks like"
 * is not a formatting convention to be pattern-matched — it is a property of the
 * data. Every identity is a pipe-delimited composite whose first segment names
 * either a source root or a fact family, and both sets are in the base.
 *
 * This is what lets a fabricated identity be told apart from an ordinary
 * backticked path or endpoint. Without it the audit can only resolve what the
 * report volunteered, and an invented row cited nowhere else looks like prose.
 */
export function identityNamespaces(store: Store, snapshotId: number): ReadonlySet<string> {
  const namespaces = new Set<string>();
  const sources: readonly [string, string][] = [
    ["structural_records", "record_key"],
    ["derived_records", "record_key"],
    ["behavior_facts", "fact_id"],
    ["evidence_items", "item_key"],
  ];
  for (const [table, column] of sources) {
    const rows = store.all(
      `select distinct substr(${column}, 1, instr(${column}, '|') - 1) as ns
         from ${table} where snapshot_id = ? and instr(${column}, '|') > 1`,
      [snapshotId],
    ) as readonly { ns: string }[];
    for (const row of rows) if (row.ns !== "") namespaces.add(row.ns);
  }
  return namespaces;
}

/** Every backticked span in the text, which is where identities are written. */
function backtickedSpans(text: string): readonly string[] {
  const found: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const span = match[1];
    if (span !== undefined) found.push(span);
  }
  return found;
}

/**
 * The identities a chapter cites, keyed by the chapter's 1-based position.
 *
 * A span counts as an identity when its first pipe-segment is one of the
 * snapshot's namespaces. Everything else in backticks — a path, an endpoint, a
 * field name — is left alone, so this adds no false positives to a report that
 * cites nothing machine-readable at all.
 */
export function citedIdentitiesBySection(
  report: string,
  namespaces: ReadonlySet<string>,
): ReadonlyMap<number, ReadonlySet<string>> {
  const bySection = new Map<number, Set<string>>();
  const sections = reportSections(report);

  sections.forEach((section, index) => {
    const found = new Set<string>();
    for (const span of backtickedSpans(section)) {
      const pipe = span.indexOf("|");
      if (pipe <= 0) continue;
      if (!namespaces.has(span.slice(0, pipe))) continue;
      found.add(span);
    }
    if (found.size > 0) bySection.set(index + 1, found);
  });

  return bySection;
}
