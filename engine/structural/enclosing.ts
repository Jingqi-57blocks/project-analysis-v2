/**
 * Attaches facts to the symbol that encloses them, by source range.
 *
 * Providers that scan text — outbound calls, declarative rules — know where a
 * fact is but not whose body it sits in. Symbol ranges come from a different
 * provider, so this runs after assembly rather than inside either one.
 *
 * A fact with no enclosing symbol keeps a null id rather than being attached
 * to the nearest candidate: file-level code genuinely has no enclosing symbol,
 * and guessing would attribute calls to functions that never make them.
 */

import type { SymbolId } from "./identity.js";
import type { SymbolRecord } from "./code.js";
import type { SourceRef } from "./provenance.js";

interface Range {
  readonly id: SymbolId;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface EnclosingIndex {
  find(source: SourceRef): SymbolId | null;
}

/**
 * Builds a lookup from symbol ranges.
 *
 * Where ranges nest, the innermost wins — a method inside a class is the
 * better answer than the class. Symbols whose range is a single line (common
 * when a provider reports only a declaration line) are still usable for facts
 * on that line.
 */
export function buildEnclosingIndex(symbols: readonly SymbolRecord[]): EnclosingIndex {
  const byFile = new Map<string, Range[]>();

  for (const symbol of symbols) {
    const source = symbol.provenance.source;
    if (source.startLine === null) continue;

    const ranges = byFile.get(source.relPath) ?? [];
    ranges.push({
      id: symbol.id,
      relPath: source.relPath,
      startLine: source.startLine,
      endLine: source.endLine ?? source.startLine,
    });
    byFile.set(source.relPath, ranges);
  }

  return {
    find(source: SourceRef): SymbolId | null {
      if (source.startLine === null) return null;
      const ranges = byFile.get(source.relPath);
      if (!ranges) return null;

      let best: Range | null = null;
      for (const range of ranges) {
        if (source.startLine < range.startLine || source.startLine > range.endLine) continue;
        if (best === null || range.endLine - range.startLine < best.endLine - best.startLine) {
          best = range;
        }
      }
      return best?.id ?? null;
    },
  };
}
