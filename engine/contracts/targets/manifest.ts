/**
 * Loader for the frozen acceptance-target manifest.
 *
 * Deterministic — the same pinned manifest yields the same targets — with
 * filters the gates use: the roots participating in a milestone, and the roots
 * no dedicated route reader covers (where the generic path must carry it).
 */

import { readFileSync } from "node:fs";

import type { AcceptanceTarget, Gate, TargetManifest, TargetRoot } from "./schema.js";

const MANIFEST_URL = new URL("../../../truth-set/targets.json", import.meta.url);

export function loadTargetManifest(): TargetManifest {
  return JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as TargetManifest;
}

export function targetById(manifest: TargetManifest, id: string): AcceptanceTarget | undefined {
  return manifest.targets.find((t) => t.id === id);
}

export interface TargetRootRef {
  readonly target: AcceptanceTarget;
  readonly root: TargetRoot;
}

export function rootsForGate(manifest: TargetManifest, gate: Gate): readonly TargetRootRef[] {
  const refs: TargetRootRef[] = [];
  for (const target of manifest.targets) {
    if (target.gates.includes(gate)) for (const root of target.roots) refs.push({ target, root });
  }
  return refs;
}

/** Roots no dedicated route reader covers — where the generic path must carry the analysis. */
export function noReaderRoots(manifest: TargetManifest): readonly TargetRootRef[] {
  const refs: TargetRootRef[] = [];
  for (const target of manifest.targets) {
    for (const root of target.roots) if (!root.hasRouteReader) refs.push({ target, root });
  }
  return refs;
}
