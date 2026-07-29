/**
 * A way into a long document, and a way to cut it up.
 *
 * Both work from the assembled Markdown rather than from the template, so the
 * contents cover the sub-headings an LLM section wrote as well as the sections
 * a template declared — and splitting cuts text that has already been agreed
 * rather than rendering it a second time.
 */

export interface Heading {
  readonly level: number;
  readonly title: string;
  readonly anchor: string;
  /** Line index in the document, so a splitter can cut here. */
  readonly line: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^```/;

/**
 * GitHub's anchor rules, which the HTML view follows too: lowercase, spaces to
 * hyphens, punctuation dropped. Duplicates get a numeric suffix, or two
 * sections with the same name would link to the same place.
 */
export function anchorFor(title: string, taken: Set<string>): string {
  const base = title
    .toLowerCase()
    .replaceAll(/[^\w\s-]/g, "")
    .trim()
    .replaceAll(/\s+/g, "-");
  let anchor = base === "" ? "section" : base;
  let n = 1;
  while (taken.has(anchor)) anchor = `${base}-${n++}`;
  taken.add(anchor);
  return anchor;
}

/** Every heading outside a fenced block — a `#` in a code sample is not one. */
export function readHeadings(markdown: string): readonly Heading[] {
  const headings: Heading[] = [];
  const taken = new Set<string>();
  let fenced = false;

  markdown.split("\n").forEach((text, line) => {
    if (FENCE.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;

    const match = HEADING.exec(text);
    if (match === null) return;
    const title = match[2]!;
    headings.push({
      level: match[1]!.length,
      title,
      anchor: anchorFor(title, taken),
      line,
    });
  });

  return headings;
}

export interface ContentsOptions {
  /** Deepest level to list. Beyond this the contents become the document. */
  readonly maxLevel?: number;
  /** Where each top-level section lives, when they are separate files. */
  readonly hrefFor?: (heading: Heading) => string;
}

/**
 * The contents, as a nested list.
 *
 * Levels below the top are indented rather than flattened: a reader scanning
 * forty entity names under "What it stores" needs to see that they belong to
 * it, not that the document has forty-one sections.
 */
export function renderContents(
  headings: readonly Heading[],
  options: ContentsOptions = {},
): string {
  const maxLevel = options.maxLevel ?? 3;
  const listed = headings.filter(
    (heading) => heading.level > 1 && heading.level <= maxLevel,
  );
  if (listed.length === 0) return "";

  const top = Math.min(...listed.map((heading) => heading.level));
  return listed
    .map((heading) => {
      const indent = "  ".repeat(heading.level - top);
      const href = options.hrefFor?.(heading) ?? `#${heading.anchor}`;
      return `${indent}- [${heading.title}](${href})`;
    })
    .join("\n");
}

/** The document with its contents inserted after the title. */
export function withContents(markdown: string, options: ContentsOptions = {}): string {
  const headings = readHeadings(markdown);
  const contents = renderContents(headings, options);
  if (contents === "") return markdown;

  const lines = markdown.split("\n");
  const title = headings.find((heading) => heading.level === 1);
  const at = title === undefined ? 0 : title.line + 1;

  return [
    ...lines.slice(0, at),
    "",
    "## Contents",
    "",
    contents,
    ...lines.slice(at),
  ].join("\n");
}

export interface DocumentPart {
  /** The section id where one is known, else a slug of the heading. */
  readonly name: string;
  readonly title: string;
  readonly markdown: string;
}

export interface SplitDocument {
  readonly index: string;
  readonly parts: readonly DocumentPart[];
}

export interface SplitOptions {
  /**
   * Sections that stay in the index rather than becoming a file.
   *
   * The limitations belong here. A reader who opens one section of a split
   * document and never sees what the analysis could not establish has been
   * handed the most confident-looking part of it on its own.
   */
  readonly keepInIndex?: readonly string[];
  /** Section id by heading title, from the manifest, for stable filenames. */
  readonly idFor?: (title: string) => string | undefined;
}

/**
 * Cuts an assembled document at its top-level sections.
 *
 * The text is moved, never rebuilt: whatever a section said as part of the
 * whole is exactly what its file says.
 */
export function splitDocument(markdown: string, options: SplitOptions = {}): SplitDocument {
  const lines = markdown.split("\n");
  const headings = readHeadings(markdown);
  const title = headings.find((heading) => heading.level === 1);
  const sections = headings.filter((heading) => heading.level === 2);

  if (sections.length === 0) return { index: markdown, parts: [] };

  const keep = new Set(options.keepInIndex ?? []);
  const taken = new Set<string>();
  const parts: DocumentPart[] = [];
  const kept: string[] = [];

  sections.forEach((heading, n) => {
    const end = n + 1 < sections.length ? sections[n + 1]!.line : lines.length;
    const body = lines.slice(heading.line, end).join("\n").trimEnd();
    const id = options.idFor?.(heading.title) ?? anchorFor(heading.title, taken);

    if (keep.has(id) || keep.has(heading.title)) {
      kept.push(body);
      return;
    }
    parts.push({ name: id, title: heading.title, markdown: `${body}\n` });
  });

  const contents = parts
    .map((part) => `- [${part.title}](sections/${part.name}.md)`)
    .join("\n");

  const head = title === undefined ? [] : lines.slice(0, title.line + 1);
  const index = [
    ...head,
    "",
    "## Contents",
    "",
    contents,
    ...(kept.length === 0 ? [] : ["", ...kept]),
    "",
  ].join("\n");

  return { index, parts };
}
