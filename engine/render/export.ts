/**
 * A rendering of an assembled document, in some other format.
 *
 * Markdown is the artifact; everything here is a view of it. So this reads the
 * files `assemble` wrote and never the knowledge base — a format cannot change
 * what a document says, and one that had to re-derive anything could.
 *
 * Each format gets its own tree. Written beside the Markdown, a ten-section
 * report becomes twenty interleaved files where half are views of the other
 * half, and the links keep pointing at `.md` — so navigation works in one
 * format and not the other.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { anchorFor, readHeadings } from "./contents.js";
import { renderHtml, type NavEntry, type RenderOptions } from "./html.js";

export const FORMATS = ["html", "md"] as const;
export type ExportFormat = (typeof FORMATS)[number];

export class UnknownFormatError extends Error {
  constructor(format: string) {
    super(`Unknown format "${format}". Available: ${FORMATS.join(", ")}`);
    this.name = "UnknownFormatError";
  }
}

/** Every Markdown file the document is made of, relative to its directory. */
export function documentFiles(runDir: string): readonly string[] {
  const found: string[] = [];
  for (const name of ["index.md", "report.md"]) {
    if (existsSync(join(runDir, name))) found.push(name);
  }

  const sectionsDir = join(runDir, "sections");
  if (existsSync(sectionsDir)) {
    found.push(
      ...readdirSync(sectionsDir)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => join("sections", name)),
    );
  }
  return found;
}

/**
 * Points a document's own links at the format they are being rendered into.
 *
 * `index.md` links to `sections/parts.md`, which is correct for Markdown. Left
 * alone in a page, that link shows raw source instead of the page beside it.
 * Only links to files of this document are rewritten; anything else is a link
 * somebody meant.
 */
export function retarget(markdown: string, extension: string): string {
  return markdown.replaceAll(
    /\]\((?!https?:|\/\/)([^)\s]+)\.md(#[^)\s]*)?\)/g,
    (_whole, path: string, fragment: string | undefined) =>
      `](${path}.${extension}${fragment ?? ""})`,
  );
}

export interface ExportResult {
  readonly format: ExportFormat;
  readonly outDir: string;
  readonly files: readonly string[];
}

/** What the sidebar needs from the manifest — nothing else is read. */
interface ManifestNav {
  readonly frame?: Readonly<Record<string, string>>;
  /** The language the document was prepared in, absent for English. */
  readonly language?: string;
  readonly sections?: readonly {
    readonly id: string;
    readonly heading: string | null;
    readonly omitted?: boolean;
  }[];
}

function readManifestNav(runDir: string): ManifestNav {
  const path = join(runDir, "manifest.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ManifestNav;
  } catch {
    return {};
  }
}

/**
 * The sidebar for one page of a split document.
 *
 * Every page lists every section, so a reader on any page can reach any other.
 * A section with its own page links there; one kept in the index (the
 * limitations, deliberately) links into the index at its anchor. The current
 * page's entry carries its own sub-headings, so within-page navigation nests
 * under it the way the whole-document sidebar nests everything.
 */
function splitNav(
  manifest: ManifestNav,
  sources: readonly string[],
  source: string,
  markdown: string,
): NavEntry[] {
  const inSections = source.startsWith("sections/");
  const taken = new Set<string>();
  const entries: NavEntry[] = [];

  for (const section of manifest.sections ?? []) {
    if (section.heading === null || section.omitted === true) continue;
    const indexAnchor = anchorFor(section.heading, taken);
    const file = `sections/${section.id}.md`;
    const current = source === file;

    let href: string;
    if (sources.includes(file)) {
      href = inSections ? `${section.id}.html` : `sections/${section.id}.html`;
    } else {
      href = inSections ? `../index.html#${indexAnchor}` : `#${indexAnchor}`;
    }

    let children: NavEntry[] | undefined;
    if (current) {
      // `readHeadings` assigns anchors with the same taken-set rules the page
      // itself renders with, so these hrefs land exactly on the heading ids.
      children = readHeadings(markdown)
        .filter((heading) => heading.level === 3)
        .map((heading) => ({ title: heading.title, href: `#${heading.anchor}` }));
      if (children.length === 0) children = undefined;
    }

    entries.push({
      title: section.heading,
      href,
      ...(current ? { current: true } : {}),
      ...(children === undefined ? {} : { children }),
    });
  }
  return entries;
}

export function exportDocument(
  runDir: string,
  format: string,
  title: string,
  outDir?: string,
): ExportResult {
  if (!(FORMATS as readonly string[]).includes(format)) throw new UnknownFormatError(format);

  const sources = documentFiles(runDir);
  if (sources.length === 0) {
    throw new Error(`No assembled document in ${runDir}. Run \`render assemble\` first.`);
  }

  const manifest = readManifestNav(runDir);
  const contentsLabel = manifest.frame?.["contents"] ?? "Contents";
  const split = sources.includes("index.md");

  const target = outDir ?? join(runDir, format);
  const files: string[] = [];

  for (const source of sources) {
    const raw = readFileSync(join(runDir, source), "utf8");
    const path = join(target, source.replace(/\.md$/, `.${format}`));
    mkdirSync(dirname(path), { recursive: true });

    if (format === "md") {
      // The Markdown is the artifact; this format hands it over as written,
      // links included — they already point at .md files beside each other.
      writeFileSync(path, raw, "utf8");
    } else {
      const markdown = retarget(raw, format);
      // A whole document navigates by its own headings; a split page needs
      // the sibling pages the markdown alone cannot know about.
      // The page states the language it is written in, so a screen reader
      // does not read a Chinese report aloud in English.
      const language = manifest.language === undefined ? {} : { language: manifest.language };
      const options: RenderOptions =
        split && source !== "report.md"
          ? {
              contentsLabel,
              ...language,
              nav: splitNav(manifest, sources, source, markdown),
              homeHref: source.startsWith("sections/") ? "../index.html" : "#",
            }
          : { contentsLabel, ...language };
      writeFileSync(path, renderHtml(markdown, title, options), "utf8");
    }
    files.push(relative(runDir, path));
  }

  return { format: format as ExportFormat, outDir: target, files };
}
