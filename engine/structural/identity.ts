/**
 * Stable identity for symbols across providers.
 *
 * Identity comes from properties of the code, never from anything a provider
 * assigns — a vendor's internal node id would make its numbering part of our
 * schema, and two providers finding the same symbol must agree without
 * coordinating.
 */

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

const DELIMITER = "|";

function escape(part: string): string {
  return part.replaceAll("\\", "\\\\").replaceAll(DELIMITER, `\\${DELIMITER}`);
}

/**
 * Without escaping, root `a|b` + path `c` and root `a` + path `b|c` collide,
 * silently merging two unrelated symbols — a failure no later stage could
 * detect.
 *
 * When `signature` is null, two overloads in one file collapse to one id.
 * Deliberate: a positional discriminator would make identity churn whenever
 * unrelated code above it moved.
 */
export function symbolId(parts: SymbolIdParts): SymbolId {
  return [parts.rootName, parts.relPath, parts.kind, parts.qualifiedName, parts.signature ?? ""]
    .map(escape)
    .join(DELIMITER) as SymbolId;
}

export function fileId(rootName: string, relPath: string): string {
  return [rootName, relPath].map(escape).join(DELIMITER);
}

/** Shares the escaping so record keys cannot forge a boundary either. */
export function joinKey(parts: readonly (string | number | null | undefined)[]): string {
  return parts.map((part) => escape(part == null ? "" : String(part))).join(DELIMITER);
}
