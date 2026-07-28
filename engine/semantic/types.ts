/**
 * Semantic evidence — the human-meaningful text developers already wrote.
 *
 * Structure alone cannot say what a system does. `POST /orders → write orders
 * → call paymentClient` does not establish "customers place an order and pay
 * by card". The honest bridge is the prose that already exists in the
 * codebase.
 *
 * This layer produces **evidence, never conclusions**. Turning evidence into a
 * description is the model's job at render time, under the claims boundary.
 */

import type { Provenance, SourceRef } from "../structural/provenance.js";
import type { SymbolId } from "../structural/identity.js";

/**
 * Conventional evidence kinds. Open, like the structural vocabularies: a
 * language or framework nobody anticipated brings its own kind of prose, and
 * forcing it into the nearest listed kind would misdescribe it.
 */
export const CONVENTIONAL_EVIDENCE_KINDS = [
  "project-title",
  "project-description",
  "readme-section",
  "doc-comment",
  "inline-comment",
  "test-name",
  "ui-label",
  "route-description",
  "type-name",
  "config-key",
  "unknown",
] as const;

export type EvidenceKind = (typeof CONVENTIONAL_EVIDENCE_KINDS)[number] | (string & {});

/**
 * One piece of evidence.
 *
 * `text` is stored as written. A future template may want different prose from
 * the same raw material, and summarizing here would discard that option
 * permanently — the summary can always be derived again, the original cannot.
 *
 * Keyed by `source`, not by module. Modules do not exist at this stage, and
 * binding evidence to them would make it unusable for any template querying by
 * another axis.
 *
 * `symbolId` is filled where a symbol reference happens to be available and
 * left null otherwise. That optionality is the point: this stage must never
 * *require* the structural model, which is what lets it run in parallel with
 * extraction rather than serialized behind it.
 */
export interface EvidenceItem {
  readonly rootName: string;
  readonly kind: EvidenceKind;
  readonly text: string;
  /** A heading, key, or symbol name giving the text context, where one exists. */
  readonly label: string | null;
  readonly symbolId: SymbolId | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

export interface CollectorCapability {
  readonly kind: EvidenceKind;
  readonly language: string;
  readonly support: "full" | "partial" | "none";
  readonly limits: readonly string[];
}

export interface CollectorCapabilities {
  readonly declarations: readonly CollectorCapability[];
}

export interface EvidenceGap {
  readonly kind: EvidenceKind;
  readonly language: string;
  readonly reason: string;
}

export interface CollectionFailure {
  readonly scope: string;
  readonly reason: string;
}

/** What a collector is given. Mirrors the structural provider's root input. */
export interface SemanticRootInput {
  readonly name: string;
  readonly path: string;
  readonly analyzedFiles: readonly string[];
}

export interface SemanticContribution {
  readonly collectorId: string;
  readonly collectorVersion: string;
  readonly rootName: string;
  readonly items: readonly EvidenceItem[];
  readonly gaps: readonly EvidenceGap[];
  readonly failures: readonly CollectionFailure[];
}

/**
 * Same shape as the structural provider on purpose: declared capabilities,
 * versioned identity, contributions merged by an assembler. Several collectors
 * run together and each is independently addable and removable.
 */
export interface SemanticCollector {
  readonly id: string;
  readonly version: string;
  capabilities(): CollectorCapabilities;
  collect(root: SemanticRootInput): SemanticContribution;
}
