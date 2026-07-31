/**
 * Identity stability across runs and batches (PI-61).
 *
 * Canonical identity must not depend on the order facts arrive, the batch they
 * arrive in, or a contract version bump. These helpers compare identity sets
 * across runs so a gate can assert there was no silent drift.
 */

import type { FactId } from "./identity.js";

/** Whether two identity sets are equal regardless of order and duplication. */
export function sameIdentitySet(a: readonly FactId[], b: readonly FactId[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

/** Ids present in some runs but not all — the identity that drifted across runs/batches. */
export function identityDrift(runs: readonly (readonly FactId[])[]): readonly FactId[] {
  if (runs.length === 0) return [];
  const counts = new Map<FactId, number>();
  for (const run of runs) {
    for (const id of new Set(run)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const drifted: FactId[] = [];
  for (const [id, count] of counts) if (count !== runs.length) drifted.push(id);
  return drifted.sort((a, b) => (a < b ? -1 : 1));
}

/** True when every run produced the same identity set — no silent drift. */
export function identityStable(runs: readonly (readonly FactId[])[]): boolean {
  return identityDrift(runs).length === 0;
}
