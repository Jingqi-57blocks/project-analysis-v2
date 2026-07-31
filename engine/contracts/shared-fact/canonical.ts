/**
 * Canonical identity for files and symbols (PI-57).
 *
 * Built on the shared-fact FactId, so it is provider-neutral: CodeGraph, a
 * source/AST provider and an enricher all resolve the same file or symbol to the
 * same canonical id, while keeping their own native ids only as attribution
 * (RawIdentity). Identity is repository-aware, so two repos with the same
 * relative path never collide; overloads are kept apart by signature and local
 * symbols by scope. When a reference cannot be resolved to exactly one symbol it
 * becomes a candidate or unresolved result — never a forced merge.
 */

import { factId, type FactId } from "./identity.js";

/**
 * Normalizes a repository-relative path to a logical form: forward slashes, no
 * leading `./`, and `.`/`..` segments resolved. Purely lexical — a symlink is
 * the repository's own structure, not ours to expand, so the path it is
 * referred to by is the identity.
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** Canonical file identity: repository + normalized path. */
export function canonicalFileId(repo: string, path: string): FactId {
  return factId({ family: "structural", kind: "source-file", discriminators: [repo, normalizePath(path)] });
}

export interface CanonicalSymbolParts {
  readonly repo: string;
  readonly path: string;
  readonly kind: string;
  readonly qualifiedName: string;
  /** Distinguishes overloads. Null where the language or provider has none. */
  readonly signature: string | null;
  /** Distinguishes local symbols sharing a name — an enclosing scope path. */
  readonly scopePath: string | null;
}

export function canonicalSymbolId(parts: CanonicalSymbolParts): FactId {
  return factId({
    family: "structural",
    kind: "symbol",
    discriminators: [parts.repo, normalizePath(parts.path), parts.kind, parts.qualifiedName, parts.signature, parts.scopePath],
  });
}

export type CanonicalResult =
  | { readonly kind: "exact"; readonly id: FactId }
  | { readonly kind: "candidate"; readonly ids: readonly FactId[] }
  | { readonly kind: "unresolved"; readonly reason: string };

/**
 * A canonical id for a symbol, or unresolved when it cannot be named uniquely.
 * An anonymous symbol with no qualified name and no scope has no stable
 * identity, so it is left unresolved rather than merged onto some other symbol.
 */
export function tryCanonicalSymbolId(parts: CanonicalSymbolParts): CanonicalResult {
  if (parts.qualifiedName === "" && (parts.scopePath === null || parts.scopePath === "")) {
    return { kind: "unresolved", reason: "anonymous symbol has no qualified name or scope to identify it" };
  }
  return { kind: "exact", id: canonicalSymbolId(parts) };
}

/**
 * Resolves a reference to the canonical symbols it might name. Zero matches is
 * unresolved; one is exact; more than one is a candidate set kept apart, never
 * merged into an arbitrary winner.
 */
export function reconcile(name: string, matches: readonly FactId[]): CanonicalResult {
  if (matches.length === 0) return { kind: "unresolved", reason: `no canonical symbol matches "${name}"` };
  if (matches.length === 1) return { kind: "exact", id: matches[0]! };
  return { kind: "candidate", ids: [...matches] };
}

/** One thing claiming a canonical id, with the tuple that ought to make it unique. */
export interface IdentityClaim {
  readonly id: FactId;
  readonly distinct: string;
}

export interface Collision {
  readonly id: FactId;
  readonly distinctValues: readonly string[];
}

/**
 * Collisions: one canonical id claimed by two genuinely different things. A
 * diagnostic, not a silent merge — the identity composition is wrong if this is
 * ever non-empty for records that should differ.
 */
export function detectCollisions(claims: readonly IdentityClaim[]): readonly Collision[] {
  const byId = new Map<string, Set<string>>();
  for (const claim of claims) {
    const set = byId.get(claim.id) ?? new Set<string>();
    set.add(claim.distinct);
    byId.set(claim.id, set);
  }
  const collisions: Collision[] = [];
  for (const [id, distincts] of byId) {
    if (distincts.size > 1) collisions.push({ id: id as FactId, distinctValues: [...distincts].sort() });
  }
  return collisions.sort((a, b) => (a.id < b.id ? -1 : 1));
}
