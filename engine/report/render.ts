/**
 * Deterministic Markdown and HTML rendering of an assembled report (PI-18).
 *
 * Both formats are produced from the one assembled structure in a single
 * mechanical step, and both share one manifest — the ordered section/block identity
 * and the document digest — so the Markdown and the HTML are two serializations of
 * the same audited document, never two independent renders that could drift. A
 * required authored block with no validated content renders as a clearly marked
 * skeleton gap, so a partial document is legible for diagnosis without ever being
 * mistaken for a finished one.
 *
 * Rendering is pure: the same assembled report and the same block-content function
 * give byte-identical output.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import type { AssembledBlock, AssembledDocument, AssembledReport } from "./assemble.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** The rendered content of one block, given the document it sits in. Empty for a gap. */
export type BlockContent = (documentId: string, block: AssembledBlock) => string;

export interface RenderedDocument {
  readonly documentId: string;
  readonly markdown: string;
  readonly html: string;
  /** Stable over both serializations — Markdown and HTML fold to the same digest input. */
  readonly digest: string;
}

export interface DocumentManifestEntry {
  readonly documentId: string;
  readonly complete: boolean;
  readonly sections: readonly { readonly sectionId: string; readonly blocks: readonly string[] }[];
  readonly structureDigest: string;
}

export interface RenderManifest {
  readonly documents: readonly DocumentManifestEntry[];
  readonly digest: string;
}

export interface RenderedReport {
  readonly documents: readonly RenderedDocument[];
  readonly manifest: RenderManifest;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const GAP_MARKDOWN = (block: AssembledBlock): string =>
  `> _[gap: ${block.blockId} — required authored block not validated]_`;

const GAP_HTML = (block: AssembledBlock): string =>
  `<p class="gap"><em>[gap: ${escapeHtml(block.blockId)} — required authored block not validated]</em></p>`;

function documentTitle(doc: AssembledDocument): string {
  const scope = doc.scope.kind === "project" ? "Project" : `Module ${doc.scope.moduleId}`;
  const audience = doc.audience === "product" ? "Product" : "Developer";
  return `${scope} — ${audience} report`;
}

/** The content a block contributes, or a marked gap when a required block did not validate. */
function blockText(documentId: string, block: AssembledBlock, content: BlockContent): { md: string; html: string } {
  if (!block.validated) return { md: GAP_MARKDOWN(block), html: GAP_HTML(block) };
  const text = content(documentId, block);
  return { md: text, html: `<div class="block" data-block="${escapeHtml(block.blockId)}">${escapeHtml(text)}</div>` };
}

function renderDocument(doc: AssembledDocument, content: BlockContent): RenderedDocument {
  const title = documentTitle(doc);
  const mdParts: string[] = [`# ${title}`];
  const htmlParts: string[] = [`<h1>${escapeHtml(title)}</h1>`];

  for (const section of doc.sections) {
    mdParts.push(`## ${section.title}`);
    htmlParts.push(`<section data-section="${escapeHtml(section.sectionId)}"><h2>${escapeHtml(section.title)}</h2>`);
    for (const block of section.blocks) {
      const { md, html } = blockText(doc.documentId, block, content);
      mdParts.push(md);
      htmlParts.push(html);
    }
    htmlParts.push(`</section>`);
  }

  const markdown = `${mdParts.join("\n\n")}\n`;
  const html = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n${htmlParts.join("\n")}\n</body>\n</html>\n`;
  // Both serializations fold to the same digest input — one audited document.
  return { documentId: doc.documentId, markdown, html, digest: digest({ documentId: doc.documentId, structure: doc.digest, markdown, html }) };
}

function manifestEntry(doc: AssembledDocument): DocumentManifestEntry {
  return {
    documentId: doc.documentId,
    complete: doc.complete,
    sections: doc.sections.map((s) => ({ sectionId: s.sectionId, blocks: s.blocks.map((b) => b.blockId) })),
    structureDigest: doc.digest,
  };
}

/**
 * Render every document to Markdown and HTML in one mechanical step, with one
 * manifest binding both serializations to the assembled structure. Deterministic
 * over the report and the content function.
 */
export function renderReport(report: AssembledReport, content: BlockContent): RenderedReport {
  const documents = report.documents.map((doc) => renderDocument(doc, content));
  const entries = report.documents.map(manifestEntry);
  const manifest: RenderManifest = { documents: entries, digest: digest(entries) };
  return { documents, manifest };
}
