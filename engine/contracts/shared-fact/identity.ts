/**
 * Stable, code-derived identity for a fact.
 *
 * Identity comes from properties of the code, never from anything a provider
 * assigns — a vendor's internal node id would make its numbering part of our
 * schema, and two providers finding the same fact must agree without
 * coordinating. A provider's own handle is kept beside the canonical id, never
 * inside it (see RawIdentity).
 */

import type { FactFamily, FactKind } from "./families.js";
import { joinKey } from "./serialization.js";

declare const factIdBrand: unique symbol;

/** Branded so a name or path cannot be passed where a fact identity is expected. */
export type FactId = string & { readonly [factIdBrand]: true };

export interface FactIdParts {
  readonly family: FactFamily;
  readonly kind: FactKind;
  /**
   * The code-derived values that make this fact unique within its kind. Chosen
   * by the fact's own kind — a symbol by qualified name, a condition by its
   * location — and never a provider's own node id, so identity survives
   * swapping the provider that found it.
   */
  readonly discriminators: readonly (string | number | null)[];
}

/**
 * The family and kind lead the key so identities from different kinds cannot
 * collide even when their discriminators coincide. The contract version is not
 * part of the id: a compatible version bump must not churn identity.
 */
export function factId(parts: FactIdParts): FactId {
  return joinKey([parts.family, parts.kind, ...parts.discriminators]) as FactId;
}

/**
 * A provider's native handle for a fact — a CodeGraph node id, an AST cursor —
 * carried alongside the canonical id. Two providers may name one fact with two
 * raw identities while sharing a single canonical FactId.
 */
export interface RawIdentity {
  readonly providerId: string;
  readonly nativeId: string;
}
