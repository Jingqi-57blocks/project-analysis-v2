/**
 * Stable identity for symbols across providers.
 *
 * The merge contract depends entirely on this: two providers that both find
 * `UserService.Create` must produce the same id, or the assembler records two
 * symbols where the codebase has one and every downstream count is wrong.
 * Identity therefore comes from properties of the *code*, never from anything
 * a provider assigns — a vendor's internal node id would make that vendor's
 * numbering part of our schema.
 */

declare const symbolIdBrand: unique symbol;

/**
 * Branded so a name, a path, or another provider's id cannot be passed where
 * an identity is expected. Every value must come from `symbolId`, which is the
 * only place the brand is applied.
 */
export type SymbolId = string & { readonly [symbolIdBrand]: true };

export interface SymbolIdParts {
  readonly rootName: string;
  readonly relPath: string;
  /** The language's own word for what this is — see `code.ts`. */
  readonly kind: string;
  /** Fully qualified where the language has such a notion, otherwise the plain name. */
  readonly qualifiedName: string;
  /**
   * Distinguishes overloads. Null where the language has no overloading, or
   * where the provider cannot supply one — see the collision note below.
   */
  readonly signature: string | null;
}

const DELIMITER = "|";

/**
 * Escapes so that a component containing the delimiter cannot forge a
 * boundary. Without this, a file named `a|b` and a file `a` holding a symbol
 * `b` could produce the same key — rare, but a silent identity collision is
 * the worst possible failure here, since it merges two unrelated symbols into
 * one and no later stage can detect it.
 */
function escape(part: string): string {
  return part.replaceAll("\\", "\\\\").replaceAll(DELIMITER, `\\${DELIMITER}`);
}

/**
 * Builds a symbol's identity from the code's own properties.
 *
 * **Known collision:** when `signature` is null, two overloads of the same
 * qualified name in the same file collapse to one id. This is deliberate
 * rather than hidden — inventing a discriminator (a line number, an ordinal)
 * would make identity unstable across edits, so a file that gains a comment
 * would change every id below it and the whole graph would churn. A provider
 * that can supply signatures avoids the collision; one that cannot has a
 * genuine capability gap, and the assembler is where that ambiguity gets
 * surfaced rather than silently merged.
 */
export function symbolId(parts: SymbolIdParts): SymbolId {
  const fields = [
    parts.rootName,
    parts.relPath,
    parts.kind,
    parts.qualifiedName,
    parts.signature ?? "",
  ];
  return fields.map(escape).join(DELIMITER) as SymbolId;
}

/**
 * Identity for a file, used where a fact belongs to a file rather than to a
 * symbol within it. Shares the escaping so file and symbol keys cannot collide.
 */
export function fileId(rootName: string, relPath: string): string {
  return [rootName, relPath].map(escape).join(DELIMITER);
}
