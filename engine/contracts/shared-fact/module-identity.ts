/**
 * Canonical module identity, and how it survives rename, split, merge, alias and
 * supersession (PI-76).
 *
 * A module is a code unit whose identity must stay stable as the codebase moves,
 * so the report scope (PI-70) and the cross-run identity tests (PI-61) can rely
 * on it. Identity is repository-scoped and built on the shared-fact FactId.
 * Lineage records make a rename or a split explicit; resolving an id follows
 * that lineage to the current module and FAILS CLOSED — an unknown id or a split
 * becomes unresolved/candidate, never a guess or a forced merge.
 */

import { factId, type FactId } from "./identity.js";
import { normalizePath } from "./canonical.js";

/** Repository-scoped canonical module id from a stable module key (its path/name). */
export function canonicalModuleId(repo: string, moduleKey: string): FactId {
  return factId({ family: "structural", kind: "module", discriminators: [repo, normalizePath(moduleKey)] });
}

export type ModuleRelation = "alias" | "supersede" | "merge" | "split";

/**
 * A lineage step. `to` is a single id for alias/supersede/merge (a rename, a
 * replacement, or one of several sources folding into one target) and several
 * ids for split (one module became many).
 */
export interface ModuleLineage {
  readonly from: FactId;
  readonly to: readonly FactId[];
  readonly relation: ModuleRelation;
  readonly reason: string;
}

export interface ModuleRegistry {
  /** The current canonical modules. */
  readonly modules: readonly FactId[];
  readonly lineage: readonly ModuleLineage[];
}

export type ModuleResolution =
  | { readonly kind: "exact"; readonly id: FactId }
  | { readonly kind: "aliased"; readonly id: FactId; readonly from: FactId }
  | { readonly kind: "candidate"; readonly ids: readonly FactId[]; readonly from: FactId }
  | { readonly kind: "unresolved"; readonly reason: string };

/**
 * Resolves a module id to the current canonical module, following lineage. Fails
 * closed: a split yields candidates (never an arbitrary pick), and an id with no
 * path to a known module is unresolved (never widened or guessed).
 */
export function resolveModule(id: FactId, registry: ModuleRegistry): ModuleResolution {
  const known = new Set<FactId>(registry.modules);
  if (known.has(id)) return { kind: "exact", id };

  const byFrom = new Map<FactId, ModuleLineage>();
  for (const step of registry.lineage) byFrom.set(step.from, step);

  const seen = new Set<FactId>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return { kind: "unresolved", reason: `module lineage cycle at ${current}` };
    seen.add(current);
    const step = byFrom.get(current);
    if (step === undefined) {
      return { kind: "unresolved", reason: `no lineage from ${id} to a known module` };
    }
    if (step.to.length !== 1) {
      return { kind: "candidate", ids: [...step.to], from: id };
    }
    const next = step.to[0]!;
    if (known.has(next)) return { kind: "aliased", id: next, from: id };
    current = next;
  }
}

/** Whether an id is a live module, an old id with a path to one, or neither. */
export function isLiveOrMigratable(id: FactId, registry: ModuleRegistry): boolean {
  const result = resolveModule(id, registry);
  return result.kind === "exact" || result.kind === "aliased";
}
