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
  /**
   * REPRODUCIBLE — the gate. The ordered sections/blocks, their slice digests and
   * validation outcomes, plus the grounded-fact-id set of each authored block. It
   * does NOT fold the rendered prose bytes, so an authored run gates on structure and
   * grounding, not on the model's exact wording.
   */
  readonly structureDigest: string;
  /** INFORMATIONAL — the Markdown/HTML bytes. Byte-equal for deterministic runs; it varies with authored prose. */
  readonly renderedBytesDigest: string;
}

export interface RenderManifest {
  readonly documents: readonly DocumentManifestEntry[];
  /** REPRODUCIBLE fold over the per-document `structureDigest` — the run's grounding/structure gate. */
  readonly structureDigest: string;
  /** INFORMATIONAL fold over the per-document rendered bytes — equal only when the prose is byte-stable. */
  readonly renderedBytesDigest: string;
}

/** Grounded fact ids per authored task — folded into `structureDigest` so grounding is gated. */
export interface RenderOptions {
  readonly groundedFactIdsByTask?: ReadonlyMap<string, readonly string[]>;
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

/** The grounded fact-id set of each authored block in the document, digest order, sorted. */
function groundedOfDocument(
  doc: AssembledDocument,
  groundedByTask: ReadonlyMap<string, readonly string[]>,
): readonly { readonly blockId: string; readonly factIds: readonly string[] }[] {
  return doc.sections
    .flatMap((s) => s.blocks)
    .filter((b) => b.taskId !== null && groundedByTask.has(b.taskId))
    .map((b) => ({ blockId: b.blockId, factIds: [...groundedByTask.get(b.taskId!)!].sort() }))
    .sort((a, b) => (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
}

function manifestEntry(
  doc: AssembledDocument,
  rendered: RenderedDocument,
  groundedByTask: ReadonlyMap<string, readonly string[]>,
): DocumentManifestEntry {
  return {
    documentId: doc.documentId,
    complete: doc.complete,
    sections: doc.sections.map((s) => ({ sectionId: s.sectionId, blocks: s.blocks.map((b) => b.blockId) })),
    // Structure + slice digests + validation outcomes (doc.digest) plus the grounded
    // fact sets — the reproducible gate. Prose bytes are excluded on purpose.
    structureDigest: digest({ structure: doc.digest, grounded: groundedOfDocument(doc, groundedByTask) }),
    renderedBytesDigest: rendered.digest,
  };
}

/**
 * Render every document to Markdown and HTML in one mechanical step, with one
 * manifest binding both serializations to the assembled structure. The manifest
 * carries two folds: `structureDigest` (structure + grounding — the reproducible
 * gate) and `renderedBytesDigest` (the Markdown/HTML bytes — informational, since
 * authored prose varies). Deterministic over the report, the content and the
 * grounded-fact sets.
 */
export function renderReport(report: AssembledReport, content: BlockContent, options: RenderOptions = {}): RenderedReport {
  const groundedByTask = options.groundedFactIdsByTask ?? new Map<string, readonly string[]>();
  const documents = report.documents.map((doc) => renderDocument(doc, content));
  const entries = report.documents.map((doc, i) => manifestEntry(doc, documents[i]!, groundedByTask));
  const manifest: RenderManifest = {
    documents: entries,
    structureDigest: digest(entries.map((e) => ({ documentId: e.documentId, structureDigest: e.structureDigest }))),
    renderedBytesDigest: digest(entries.map((e) => ({ documentId: e.documentId, renderedBytesDigest: e.renderedBytesDigest }))),
  };
  return { documents, manifest };
}
