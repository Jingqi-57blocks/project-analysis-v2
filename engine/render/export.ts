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

import { renderHtml } from "./html.js";

export const FORMATS = ["html"] as const;
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

  const target = outDir ?? join(runDir, format);
  const files: string[] = [];

  for (const source of sources) {
    const markdown = retarget(readFileSync(join(runDir, source), "utf8"), format);
    const path = join(target, source.replace(/\.md$/, `.${format}`));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderHtml(markdown, title), "utf8");
    files.push(relative(runDir, path));
  }

  return { format: format as ExportFormat, outDir: target, files };
}
