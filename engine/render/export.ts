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
import { dirname, join, relative, sep } from "node:path";

import { anchorFor } from "./contents.js";
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
  /** The template that produced the document — overview, capability, coverage. */
  readonly template?: string;
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
 * A section with its own page links there; the one kept in the index — the
 * document's first section — links into the index at its anchor. One entry per
 * section, with nothing nested: these pages are short enough that a second
 * table of contents beside them was only in the way.
 */
function splitNav(
  manifest: ManifestNav,
  sources: readonly string[],
  source: string,
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

    // No sub-headings nested under the current page: one entry per section,
    // like the whole-document sidebar. A page short enough to read in a minute
    // does not need a second table of contents beside it.
    entries.push({
      title: section.heading,
      href,
      ...(current ? { current: true } : {}),
    });
  }
  return entries;
}

/**
 * The document's own title, as its first heading states it.
 *
 * The caller passes the template's title, which still carries `$project` or
 * `$capability` — a reader with four tabs open saw `$project` on three of them.
 * The heading was resolved at prepare time, so it is the one thing on the page
 * that already knows the answer.
 */
function titleOf(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return heading === undefined || heading === "" ? fallback : heading;
}

/**
 * The document's title, from whichever file carries its heading.
 *
 * A section page starts at its own `##`, so reading each page in isolation left
 * every one but the index falling back to the template's `$project`. The title
 * is a property of the document, so it is read once from the whole document or
 * its index and used everywhere.
 */
function documentTitle(runDir: string, sources: readonly string[], fallback: string): string {
  for (const source of ["report.md", "index.md"]) {
    if (!sources.includes(source)) continue;
    try {
      return titleOf(readFileSync(join(runDir, source), "utf8"), fallback);
    } catch {
      // Try the other one.
    }
  }
  return fallback;
}

/** `Leave — Business Rules`, so a tab says which part of which report it is. */
function pageTitle(document: string, markdown: string): string {
  const section = /^##\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return section === undefined || section === "" ? document : `${document} — ${section}`;
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
  const document = documentTitle(runDir, sources, title);

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
      // Every page links back to the run's own listing, which sits one level
      // above the document's folder.
      const depth = source.startsWith("sections/") ? "../../" : "../";
      const home = { href: `${depth}index.html`, label: manifest.frame?.["all-reports"] ?? "All reports" };
      const kind = manifest.template === undefined ? {} : { kind: manifest.template };
      const options: RenderOptions =
        split && source !== "report.md"
          ? {
              contentsLabel,
              ...language,
              home,
              ...kind,
              nav: splitNav(manifest, sources, source),
              homeHref: source.startsWith("sections/") ? "../index.html" : "#",
            }
          : { contentsLabel, ...language, home, ...kind };
      const heading = source === "report.md" || source === "index.md"
        ? document
        : pageTitle(document, markdown);
      writeFileSync(path, renderHtml(markdown, heading, options), "utf8");
    }
    files.push(relative(runDir, path));
  }

  return { format: format as ExportFormat, outDir: target, files };
}

/**
 * One page listing every report of a run.
 *
 * A reader handed four documents had to open each one's own index to find out
 * which it was. Written beside them and refreshed on every export, so it grows
 * as a run's documents are produced rather than needing a separate command.
 */
export function writeRunIndex(
  runRoot: string,
  heading: string,
  label: string,
  language?: string,
  kindLabels: Readonly<Record<string, string>> = {},
): string | null {
  let entries: { href: string; title: string; folder: string; kind: string | undefined }[] = []; 
  try {
    entries = readdirSync(runRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        for (const page of ["report.html", "index.html"]) {
          const path = join(runRoot, entry.name, page);
          if (!existsSync(path)) continue;
          const html = readFileSync(path, "utf8");
          const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
          const kind = /<meta name="pa-kind" content="([^"]*)">/.exec(html)?.[1];
          return [
            {
              href: `${entry.name}/${page}`,
              title: title === undefined || title === "" ? entry.name : title,
              // What the document is, in the report's language. Two documents of
              // one project can share a title — an overview is named after the
              // project — and "a capability report" tells them apart in a way a
              // folder name does not.
              folder: (kind === undefined ? undefined : kindLabels[kind]) ?? entry.name,
              kind,
            },
          ];
        }
        return [];
      })
      // The overview first, whatever it is called — a reader opens it before any
      // capability. Alphabetical order put it fourth of five, because it is
      // named after the project.
      .sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || a.title.localeCompare(b.title));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const list = entries
    .map(
      (entry) =>
        `<li><a href="${escapeHtml(entry.href)}">` +
        `<span class="name">${escapeHtml(entry.title)}</span>` +
        `<span class="where">${escapeHtml(entry.folder)}</span></a></li>`,
    )
    .join("\n");
  const page = `# ${heading}\n\n${label}\n`;
  // Inside the content div, not after it: `renderHtml` wraps a page's body in
  // `#doc`, and every rule that styles this list is scoped to it. Injected
  // after `</main>` the list rendered as a bare bulleted list of blue links.
  const rendered = renderHtml(page, heading, language === undefined ? {} : { language });
  const html = rendered.includes("</div>\n</main>")
    ? rendered.replace("</div>\n</main>", `<ul class="reports">\n${list}\n</ul>\n</div>\n</main>`)
    : rendered.replace("</main>", `<ul class="reports">\n${list}\n</ul>\n</main>`);
  const path = join(runRoot, "index.html");
  writeFileSync(path, html, "utf8");
  linkDocumentNames(runRoot, entries);
  return path;
}

/**
 * Turns a capability's name into a link, where that capability has a report.
 *
 * A writer must not add these: a run exports the documents it was asked for, so
 * a link written into an answer points at a page that may not exist — forty of
 * them is forty chances to be wrong, and a dead link is worse than none. Here
 * the run's own folder is the evidence: a name is linked when a sibling
 * document is titled exactly that, and left as plain text otherwise.
 *
 * Run after every export, so a document produced before its capability's report
 * gains the link as soon as that report exists.
 */
function linkDocumentNames(
  runRoot: string,
  documents: readonly { href: string; title: string; folder: string }[],
): void {
  if (documents.length < 2) return;

  for (const document of documents) {
    const pages = [
      join(runRoot, document.folder, "report.html"),
      join(runRoot, document.folder, "index.html"),
      ...sectionPages(join(runRoot, document.folder, "sections")),
    ].filter((page) => existsSync(page));

    for (const page of pages) {
      const depth = page.includes(`${sep}sections${sep}`) ? "../../" : "../";
      let html = readFileSync(page, "utf8");
      let changed = false;

      for (const target of documents) {
        // Never link a document to itself, and never wrap a name that is
        // already a link.
        if (target.folder === document.folder) continue;
        const bold = `<strong>${escapeHtml(target.title)}</strong>`;
        if (!html.includes(bold)) continue;
        html = html.replaceAll(
          bold,
          `<strong><a href="${depth}${target.href}">${escapeHtml(target.title)}</a></strong>`,
        );
        changed = true;
      }

      if (changed) writeFileSync(page, html, "utf8");
    }
  }
}


/**
 * Reading order: the overview, then the capabilities, then how far to trust it.
 *
 * The overview first because a reader opens it before any capability;
 * alphabetical order put it fourth of five, since it is named after the
 * project. Coverage last because it is a report about the analysis rather than
 * about the system.
 */
function rankOf(kind: string | undefined): number {
  if (kind === "overview") return 0;
  if (kind === "coverage") return 2;
  return 1;
}

function sectionPages(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".html"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
