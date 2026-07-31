/**
 * Stable identity for symbols across providers.
 *
 * The canonical serialization it is built on now comes from the shared-fact
 * contract (PI-54); symbol identity stays here because it is one specific
 * application of that scheme. `joinKey` is re-exported so existing callers keep
 * importing it from this module.
 */

import { joinKey } from "../contracts/shared-fact/serialization.js";

export { joinKey };

declare const symbolIdBrand: unique symbol;

/** Branded so a name or path cannot be passed where an identity is expected. */
export type SymbolId = string & { readonly [symbolIdBrand]: true };

export interface SymbolIdParts {
  readonly rootName: string;
  readonly relPath: string;
  readonly kind: string;
  readonly qualifiedName: string;
  /** Distinguishes overloads. Null where the language or provider has none. */
  readonly signature: string | null;
}

/**
 * When `signature` is null, two overloads in one file collapse to one id.
 * Deliberate: a positional discriminator would make identity churn whenever
 * unrelated code above it moved.
 */
export function symbolId(parts: SymbolIdParts): SymbolId {
  return joinKey([
    parts.rootName,
    parts.relPath,
    parts.kind,
    parts.qualifiedName,
    parts.signature,
  ]) as SymbolId;
}

export function fileId(rootName: string, relPath: string): string {
  return joinKey([rootName, relPath]);
}
