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
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Keyed by root as well as path. Two roots analyzed together can both contain
 * `src/main.go`, and keying on the path alone would attach a fact from one
 * service to a symbol in another.
 */
function fileKey(rootName: string, relPath: string): string {
  return `${rootName}\u0000${relPath}`;
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

    const key = fileKey(source.rootName, source.relPath);
    const ranges = byFile.get(key) ?? [];
    ranges.push({
      id: symbol.id,
      startLine: source.startLine,
      endLine: source.endLine ?? source.startLine,
    });
    byFile.set(key, ranges);
  }

  return {
    find(source: SourceRef): SymbolId | null {
      if (source.startLine === null) return null;
      const ranges = byFile.get(fileKey(source.rootName, source.relPath));
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

/**
 * Fields naming the symbol a fact sits inside, by kind.
 *
 * Text-scanning providers know where a fact is but not whose body it is in,
 * because symbol ranges come from a different provider entirely. Filling these
 * in is therefore an assembly-time step, not something either provider could
 * do alone.
 */
const ENCLOSING_FIELDS: Readonly<Record<string, string>> = {
  "outbound-call": "callerSymbolId",
  "data-access": "symbolId",
  "auth-annotation": "symbolId",
  "validation-rule": "subjectSymbolId",
  "transaction-boundary": "symbolId",
  "error-handling": "symbolId",
};

/**
 * Fills in the enclosing symbol for one record, where the kind has such a
 * field, it is still null, and a symbol's range actually contains the fact.
 *
 * Returns the record unchanged when there is no match — an unattributed fact
 * is honest, and attaching it to the nearest symbol would credit calls to
 * functions that never make them.
 */
export function attachEnclosingSymbol(
  kind: string,
  record: unknown,
  index: EnclosingIndex,
): unknown {
  const field = ENCLOSING_FIELDS[kind];
  if (!field) return record;

  const fields = record as Record<string, unknown> & { provenance?: { source: SourceRef }; source?: SourceRef };
  if (fields[field] != null) return record;

  const source = fields.source ?? fields.provenance?.source;
  if (!source) return record;

  const enclosing = index.find(source);
  return enclosing === null ? record : { ...fields, [field]: enclosing };
}
