/**
 * The pieces every fragment is built from.
 *
 * Split out of `fragments.ts` so a document's own fragments can live in their own
 * module without either importing the other: the registry needs the documents, the
 * documents need these, and a cycle is what a shared module is for.
 */

import type { KnowledgeBase } from "../kb/query.js";
import type { SilentFile } from "../kb/profiles.js";
import { FRAME_EN, t, type Glossary } from "./strings.js";

export interface FragmentInput {
  /** Selector name → what it resolved to, in the order the section listed. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  readonly kb: KnowledgeBase;
  /** The report's frame words. English when a caller supplied no language. */
  readonly frame?: Glossary;
}

export class FragmentError extends Error {
  /** The caller passes the registry's names: only the registry knows them. */
  constructor(name: string, available: readonly string[]) {
    super(`Unknown fragment "${name}". Available: ${available.join(", ")}`);
    this.name = "FragmentError";
  }
}

export type Fragment = (input: FragmentInput) => string;

export function pick<T>(input: FragmentInput, selector: string): T | undefined {
  return input.data[selector] as T | undefined;
}


export function cell(text: unknown): string {
  // An empty string is absence too, and it rendered as a blank cell where every
  // other absence in these documents reads as a dash.
  const value = text === null || text === undefined || text === "" ? "—" : String(text);
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * How many silent files a section names per repository.
 *
 * Per repository, not overall, because a global top-N is decided by the biggest
 * repository: on a five-root workspace, 22 of 25 rows came from the front end and
 * two repositories were named nowhere at all — including the one whose model
 * files declare the schema the report describes. The issue asked for a
 * per-repository view, and a global sort is not one.
 *
 * Enough to be useful on a real repository, few enough that this does not become
 * the longest section in the report. What is dropped is counted, so a truncated
 * list never reads as a complete one.
 */
export const SILENT_PER_ROOT = 8;

/** A file's size in the unit a reader can weigh, rather than raw bytes. */
export function fileSize(frame: Glossary, bytes: number): string {
  return bytes >= 1024 ? t(frame, "kib", Math.round(bytes / 1024)) : t(frame, "bytes", bytes);
}

/**
 * The shared body of the two silence sections.
 *
 * Split by scope rather than branching inside one fragment, the same way flow
 * coverage is: a fragment must read only the selectors its section declared, and
 * a guard test enforces that.
 *
 * Two groups, because there are two facts and conflating them was wrong in both
 * directions. A **silent** file was read and says nothing about behaviour. An
 * **unread** file produced nothing at all, so whether it holds behaviour is
 * unknown rather than absent — a stronger statement, and the one that matters
 * most when the file is a model declaring a table. Putting the second group in
 * the first led the list with a file that is entirely commented out; leaving it
 * out altogether hid forty-one model files.
 *
 * Grouped by repository within each, so every repository with something to say
 * gets named however large its neighbours are.
 */
export function silence(
  input: FragmentInput,
  silent: readonly SilentFile[] | undefined,
  unread: readonly SilentFile[] | undefined,
  emptyKey: string,
): string {
  const f = input.frame ?? FRAME_EN;
  if (silent === undefined) return "";
  if (silent.length === 0 && (unread ?? []).length === 0) return t(f, emptyKey);

  const parts: string[] = [];
  if (silent.length > 0) {
    parts.push(t(f, "silent-lead"), ...groupedByRoot(f, silent));
  }
  if ((unread ?? []).length > 0) {
    parts.push(t(f, "unread-lead"), ...groupedByRoot(f, unread!));
  }
  parts.push(t(f, "silent-note"));
  return parts.join("\n\n");
}

/** One table per repository, each ordered by size and truncated on its own. */
export function groupedByRoot(f: Glossary, files: readonly SilentFile[]): string[] {
  const byRoot = new Map<string, SilentFile[]>();
  for (const file of files) {
    const group = byRoot.get(file.rootName) ?? [];
    group.push(file);
    byRoot.set(file.rootName, group);
  }

  const parts: string[] = [];
  const single = byRoot.size === 1;
  for (const [rootName, group] of [...byRoot.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    // One repository needs no heading — the paths already say which it is.
    if (!single) parts.push(t(f, "silent-in", rootName));
    const shown = group.slice(0, SILENT_PER_ROOT);
    parts.push(
      table(
        [t(f, "col-file"), t(f, "col-size")],
        shown.map((file) => [
          single ? `${file.rootName}/${file.relPath}` : file.relPath,
          fileSize(f, file.sizeBytes),
        ]),
      ),
    );
    if (group.length > shown.length) parts.push(t(f, "and-more", group.length - shown.length));
  }
  return parts;
}

export function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  if (rows.length === 0) return "";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

export function mermaid(source: string): string {
  return source.trim() === "" ? "" : ["```mermaid", source, "```"].join("\n");
}

/**
 * Whether any reader supplied records of a kind.
 *
 * Not how many. `capability_results` holds one row per provider *and*
 * language, each carrying that provider's whole count for the kind, so
 * summing the column counts the same records several times over — a number
 * stated to a reader that no row in the knowledge base supports.
 */

/**
 * `6 of 8 (75%)`, or `0 of 0` where a percentage would divide by nothing.
 *
 * Rounded down short of the whole: `Math.round` prints "(100%)" for 199 of 200,
 * and a reader who sees 100% stops looking for the one that is missing.
 */
export function share(frame: Glossary, part: number, whole: number): string {
  if (whole === 0) return t(frame, "of-total", part, whole);
  const exact = (part / whole) * 100;
  const percent = part < whole ? Math.min(Math.floor(exact), 99) : Math.round(exact);
  return t(frame, "of-total-percent", part, whole, percent);
}
