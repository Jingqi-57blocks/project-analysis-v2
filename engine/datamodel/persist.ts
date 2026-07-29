/**
 * Puts what a project stores into the same model as everything else it does.
 *
 * The schema readers were built before the structural model had a place for
 * them, so they have their own contribution shape and their own vocabulary —
 * `field`, not `entity-field`; a flat list, not a merged model. Rather than
 * rewrite three readers, this translates their output at the boundary.
 *
 * What that buys is the merge contract. A table declared by a SQL migration,
 * altered by an ORM migration and mapped by a Go struct is one table three
 * readers agree on. Concatenating their output made it three tables and lost
 * the agreement; going through this path makes it one record with three
 * attributions, and any disagreement between them is retained as a conflict
 * rather than silently won by whichever ran last.
 */

import type { Store } from "../store/types.js";
import { recordContribution, type PersistCounts } from "../structural/persist.js";
import { emptyRecords } from "../structural/kinds.js";
import {
  ANY_LANGUAGE,
  type CapabilityDeclaration,
  type CapabilityGap,
  type ProviderCapabilities,
  type StructuralContribution,
} from "../structural/provider.js";
import type { StructuralKind } from "../structural/kinds.js";
import type {
  DataModelCapabilities,
  DataModelContribution,
  DataModelRecords,
} from "./types.js";

/**
 * The schema readers' vocabulary, in the model's.
 *
 * `field` alone would collide with nothing today and with something eventually
 * — the model is open to any provider, and a kind named after a database
 * concept has to say which concept.
 */
const KIND_BY_DATA_KIND: Readonly<Record<string, StructuralKind>> = {
  entity: "entity",
  field: "entity-field",
  relation: "entity-relation",
  constraint: "entity-constraint",
};

export function structuralKindOf(dataKind: string): StructuralKind | null {
  return KIND_BY_DATA_KIND[dataKind] ?? null;
}

/** The four record lists, in the model's buckets. */
export function toStructuralRecords(records: DataModelRecords) {
  return {
    ...emptyRecords(),
    entity: records.entities,
    "entity-field": records.fields,
    "entity-relation": records.relations,
    "entity-constraint": records.constraints,
  };
}

/**
 * A schema reader's capabilities as the model states them.
 *
 * A kind the reader never mentioned stays unmentioned. That is what keeps
 * "this project declares no tables" apart from "no reader in this run could
 * read the way this project declares them" — the distinction the whole
 * capability model exists for, and the one a flat list of entities destroyed.
 */
export function toStructuralCapabilities(
  capabilities: DataModelCapabilities,
): ProviderCapabilities {
  const declarations: CapabilityDeclaration[] = [];
  for (const declaration of capabilities.declarations) {
    const kind = structuralKindOf(declaration.kind);
    if (kind === null) continue;
    declarations.push({
      kind,
      language: declaration.language === "" ? ANY_LANGUAGE : declaration.language,
      support: declaration.support,
      limits: declaration.limits,
    });
  }
  return { declarations };
}

export function toStructuralContribution(
  contribution: DataModelContribution,
): StructuralContribution {
  const gaps: CapabilityGap[] = [];
  for (const gap of contribution.gaps) {
    const kind = structuralKindOf(gap.kind);
    // A gap about a kind this model has no name for is still a gap. Dropping
    // it would turn a declared limit into silence, which is the one thing a
    // gap must never become — so it is filed against the entity kind, where a
    // reader looking at the data model will find it.
    gaps.push({
      kind: kind ?? "entity",
      language: gap.language === "" ? ANY_LANGUAGE : gap.language,
      reason: kind === null ? `${gap.kind}: ${gap.reason}` : gap.reason,
    });
  }

  return {
    providerId: contribution.providerId,
    providerVersion: contribution.providerVersion,
    rootName: contribution.rootName,
    records: toStructuralRecords(contribution.records),
    gaps,
    failures: contribution.failures,
  };
}

/**
 * Persists one schema reader's findings for one root.
 *
 * Goes through `recordContribution` rather than writing rows itself, so the
 * dedupe, the attribution and the capability accounting are the same code
 * paths every other provider uses — a second implementation of "merge if the
 * key matches" is a second chance to get it subtly different.
 */
export function recordDataModel(
  store: Store,
  snapshotId: number,
  sourceRootId: number,
  contribution: DataModelContribution,
  capabilities: DataModelCapabilities | null = null,
): PersistCounts {
  return recordContribution(
    store,
    snapshotId,
    sourceRootId,
    toStructuralContribution(contribution),
    capabilities === null ? null : toStructuralCapabilities(capabilities),
  );
}
