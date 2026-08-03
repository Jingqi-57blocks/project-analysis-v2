/**
 * Building the module directory from the store.
 *
 * The identities come from the classified modules the analysis already produced;
 * this layer only strips language out of them. Display names are not generated
 * here — they are produced per language by the report layer and attached to an
 * identity that never moves.
 */

import { categorize, type ModuleDirectory, type ModuleIdentity, type ModuleShape } from "../contracts/module/index.js";
import type { Store } from "../store/types.js";

interface StoredModule {
  readonly id: string;
  readonly name: string;
  readonly rootNames?: readonly string[];
  readonly endpoints?: readonly unknown[];
  readonly dataEntities?: readonly unknown[];
  readonly outboundTargets?: readonly unknown[];
  readonly symbolCount?: number;
}

function shapeOf(module: StoredModule, dependentCount: number): ModuleShape {
  return {
    endpointCount: module.endpoints?.length ?? 0,
    dataEntityCount: module.dataEntities?.length ?? 0,
    outboundTargetCount: module.outboundTargets?.length ?? 0,
    symbolCount: module.symbolCount ?? 0,
    dependentCount,
  };
}

/**
 * Reads the identities. Display names are supplied separately, so a directory
 * built here is complete for addressing by id, structural name or alias, and
 * gains language only when a report attaches it.
 */
export function readModuleIdentities(store: Store, snapshotId: number): readonly ModuleIdentity[] {
  const rows = store.all(`select payload from derived_records where snapshot_id = ? and kind = 'module'`, [
    snapshotId,
  ]) as readonly { payload: string }[];
  const modules = rows.map((row) => JSON.parse(row.payload) as StoredModule);
  const dependents = new Map<string, number>();
  const edges = store.all(`select payload from derived_records where snapshot_id = ? and kind = 'map-edge'`, [
    snapshotId,
  ]) as readonly { payload: string }[];
  for (const edge of edges) {
    const parsed = JSON.parse(edge.payload) as { to?: string };
    if (typeof parsed.to === "string") dependents.set(parsed.to, (dependents.get(parsed.to) ?? 0) + 1);
  }
  return modules
    .map((module) => ({
      id: module.id,
      structuralName: module.name,
      category: categorize(shapeOf(module, dependents.get(module.id) ?? 0)),
      rootNames: [...(module.rootNames ?? [])],
      aliases: [],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** A directory for one language, or for none when display names are not yet generated. */
export function buildModuleDirectory(
  store: Store,
  snapshotId: number,
  displayNames: ModuleDirectory["displayNames"] = [],
): ModuleDirectory {
  return { identities: readModuleIdentities(store, snapshotId), displayNames };
}
