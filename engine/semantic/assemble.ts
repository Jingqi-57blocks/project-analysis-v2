/**
 * Merges per-collector contributions into one evidence set.
 *
 * The merge rules match the structural assembler's, deliberately: two
 * assemblers with subtly different conflict behaviour would be a source of
 * disagreement nobody could explain later.
 */

import { joinKey } from "../structural/identity.js";
import type {
  CollectionFailure,
  EvidenceGap,
  EvidenceItem,
  SemanticCollector,
  SemanticContribution,
  SemanticRootInput,
} from "./types.js";

export interface EvidenceAttribution {
  readonly collectorId: string;
  readonly collectorVersion: string;
}

export interface AssembledEvidence {
  readonly key: string;
  readonly item: EvidenceItem;
  readonly attributions: readonly EvidenceAttribution[];
  /**
   * Text other collectors found for the same location and kind, kept rather
   * than discarded. Where documentation and code disagree, silently preferring
   * one is a claim this stage cannot support.
   */
  readonly conflictingText: readonly { readonly collectorId: string; readonly text: string }[];
}

export interface AssembledEvidenceSet {
  readonly rootName: string;
  readonly items: readonly AssembledEvidence[];
  readonly gaps: readonly (EvidenceGap & { readonly collectorId: string })[];
  readonly failures: readonly (CollectionFailure & { readonly collectorId: string })[];
}

/**
 * Identity for one item: what kind of evidence, from exactly where.
 *
 * Text is not part of the key. Two collectors reading the same comment must
 * converge on one item; if they disagree about its text, that disagreement is
 * recorded rather than becoming two independent facts.
 */
export function evidenceKey(item: EvidenceItem): string {
  return joinKey([
    item.rootName,
    item.kind,
    item.source.relPath,
    item.source.startLine,
    item.source.startColumn,
    item.label,
  ]);
}

export function assembleEvidence(
  rootName: string,
  contributions: readonly SemanticContribution[],
): AssembledEvidenceSet {
  const pending = new Map<
    string,
    { item: EvidenceItem; attributions: EvidenceAttribution[]; conflicts: { collectorId: string; text: string }[] }
  >();
  const gaps: (EvidenceGap & { collectorId: string })[] = [];
  const failures: (CollectionFailure & { collectorId: string })[] = [];

  for (const contribution of contributions) {
    const attribution: EvidenceAttribution = {
      collectorId: contribution.collectorId,
      collectorVersion: contribution.collectorVersion,
    };

    for (const item of contribution.items) {
      const key = evidenceKey(item);
      const existing = pending.get(key);

      if (!existing) {
        pending.set(key, { item, attributions: [attribution], conflicts: [] });
        continue;
      }

      existing.attributions.push(attribution);
      if (existing.item.text !== item.text) {
        existing.conflicts.push({ collectorId: contribution.collectorId, text: item.text });
      }
    }

    for (const gap of contribution.gaps) gaps.push({ ...gap, collectorId: contribution.collectorId });
    for (const failure of contribution.failures) {
      failures.push({ ...failure, collectorId: contribution.collectorId });
    }
  }

  return {
    rootName,
    items: [...pending.entries()].map(([key, value]) => ({
      key,
      item: value.item,
      attributions: value.attributions,
      conflictingText: value.conflicts,
    })),
    gaps,
    failures,
  };
}

/**
 * Runs every collector, isolating each one's failure.
 *
 * A collector that throws contributes a failure and nothing else; the others
 * are unaffected. Same isolation used everywhere else in this codebase.
 */
export function collectAll(
  collectors: readonly SemanticCollector[],
  root: SemanticRootInput,
): readonly SemanticContribution[] {
  return collectors.map((collector) => {
    try {
      return collector.collect(root);
    } catch (error) {
      return {
        collectorId: collector.id,
        collectorVersion: collector.version,
        rootName: root.name,
        items: [],
        gaps: [],
        failures: [
          { scope: root.name, reason: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  });
}
