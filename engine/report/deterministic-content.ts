/**
 * The deterministic block-content renderer (PI-21/22/23): the `BlockContent` seam
 * `renderReport` reads, backed by the slice resolver rather than a model.
 *
 * For each block it resolves the block's bounded slice into cited facts and emits
 * a bounded, cited-fact digest — one bullet per fact carrying the fact id, its
 * verbatim value, its kind and its `root/relPath:line` citation. A block whose
 * slice resolves nothing renders the section's STRUCTURED not-applicable / unknown
 * reason from the applicability decision — never a fabricated success and never a
 * silent blank. An authored block renders the same digest, explicitly labelled a
 * deterministic fact digest whose prose is deferred to the LLM authoring phase, so
 * a reader is never shown a placeholder mistaken for finished prose.
 *
 * Pure over the frozen KB and the plan: the same resolver and decisions give
 * byte-identical text, which is what keeps the rendered report digests reproducible.
 */

import { stableStringify } from "../contracts/shared-fact/merge.js";
import type { SourceRef } from "../contracts/shared-fact/provenance.js";
import { SECTION_CATALOG, type SectionDefinition } from "../contracts/report/catalog.js";
import type { ContentBlock } from "../contracts/report/blocks.js";
import type { Scope } from "../contracts/report/target.js";
import type { SectionApplicabilityDecision } from "./applicability.js";
import type { AssembledBlock } from "./assemble.js";
import type { BlockContent } from "./render.js";
import { type CitedFact, type SliceReaders, resolveSliceFacts } from "./slice-resolve.js";

/** Applicability decisions, indexed documentId → sectionId → decision. */
export type DecisionIndex = ReadonlyMap<string, ReadonlyMap<string, SectionApplicabilityDecision>>;

export interface DeterministicContentOptions {
  readonly readers: SliceReaders;
  readonly decisions: DecisionIndex;
  /** Defaults to the shared section catalog. */
  readonly catalog?: readonly SectionDefinition[];
  /** Cited bullets rendered per block before the digest is capped. Default 40. */
  readonly bulletCap?: number;
  /** Characters of a fact's verbatim value shown before truncation. Default 200. */
  readonly valueCap?: number;
}

const DEFAULT_BULLET_CAP = 40;
const DEFAULT_VALUE_CAP = 200;

interface CatalogEntry {
  readonly section: SectionDefinition;
  readonly block: ContentBlock;
}

function indexBlocks(catalog: readonly SectionDefinition[]): ReadonlyMap<string, CatalogEntry> {
  const index = new Map<string, CatalogEntry>();
  for (const section of catalog) {
    for (const block of section.blocks) index.set(block.id, { section, block });
  }
  return index;
}

function scopeLabel(scope: Scope): string {
  return scope.kind === "project" ? "project" : `module:${scope.moduleId}`;
}

/** `root/relPath:line` — the reader-facing citation, with a line range when it has one. */
function citationLabel(citation: SourceRef): string {
  const path = `${citation.rootName}/${citation.relPath}`;
  if (citation.startLine === null) return path;
  const line =
    citation.endLine !== null && citation.endLine !== citation.startLine
      ? `${citation.startLine}-${citation.endLine}`
      : `${citation.startLine}`;
  return `${path}:${line}`;
}

/** A fact's verbatim value as one stable, bounded line. */
function valueLabel(value: unknown, valueCap: number): string {
  const text = stableStringify(value).replace(/\s+/g, " ");
  return text.length > valueCap ? `${text.slice(0, valueCap)}…` : text;
}

function citedBullet(fact: CitedFact, valueCap: number): string {
  return `- [${fact.factId}] «${valueLabel(fact.value, valueCap)}» (${fact.kind}) — ${citationLabel(fact.citation)}`;
}

/**
 * Build the deterministic `BlockContent`. Each block resolves its own bounded
 * slice; a non-empty slice renders a capped cited-fact digest, an empty one the
 * section's structured applicability reason. Deterministic over the frozen KB.
 */
export function deterministicContent(options: DeterministicContentOptions): BlockContent {
  const catalog = options.catalog ?? SECTION_CATALOG;
  const bulletCap = options.bulletCap ?? DEFAULT_BULLET_CAP;
  const valueCap = options.valueCap ?? DEFAULT_VALUE_CAP;
  const blocks = indexBlocks(catalog);

  return (documentId: string, assembled: AssembledBlock): string => {
    const entry = blocks.get(assembled.blockId);
    if (entry === undefined) {
      return `_[no catalog entry for block ${assembled.blockId} — cannot resolve a slice]_`;
    }

    const authored = entry.block.kind === "authored-required";
    const label = authored
      ? "deterministic fact digest — prose deferred to the LLM authoring phase"
      : "deterministic fact digest";

    const facts = resolveSliceFacts(options.readers, assembled.sliceScope, entry.block.inputFactKinds);
    if (facts.length === 0) {
      // No cited fact — disclose the section's structured reason, never a blank.
      const decision = options.decisions.get(documentId)?.get(entry.section.id);
      const reason =
        decision === undefined
          ? "unknown: no applicability decision was recorded for this section"
          : `${decision.applicability}: ${decision.reason}`;
      return `_[${label}]_\n> _${entry.section.id} resolved no cited facts for ${scopeLabel(assembled.sliceScope)} — structured ${reason}_`;
    }

    const shown = facts.slice(0, bulletCap);
    const bullets = shown.map((fact) => citedBullet(fact, valueCap));
    const header = `_[${label}: ${facts.length} cited fact${facts.length === 1 ? "" : "s"} for ${scopeLabel(assembled.sliceScope)}]_`;
    const overflow = facts.length > shown.length ? [`- … ${facts.length - shown.length} more cited fact(s) elided from this digest`] : [];
    return [header, ...bullets, ...overflow].join("\n");
  };
}
