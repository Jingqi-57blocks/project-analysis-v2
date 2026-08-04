/**
 * Connects tests to the production code they exercise.
 *
 * Test files are identified by convention; targets come from the call edges the
 * assembled model already holds, so this reads the model rather than re-parsing
 * source. That is what makes it a deriver over the behaviour model and not a
 * provider: it reads no file and contributes no structural record of its own.
 *
 * It was written as a provider and never registered — `defaultReaders` does not
 * include it, and its only caller is `behavior-input.ts`, which calls the
 * derivation directly. The shell around it declared capabilities nothing read
 * and a preflight nothing ran, which made it look like a reader that had been
 * switched off rather than one that had never existed.
 */

import { basename } from "node:path";

import { resolved, unresolved } from "../structural/provenance.js";
import type { CallEdgeRecord, SymbolRecord } from "../structural/code.js";
import type { TestRelationRecord } from "../structural/boundaries.js";
import type { SymbolId } from "../structural/identity.js";

/**
 * Naming conventions across languages. Open-ended by design: a project using
 * an unlisted convention yields no test relations rather than wrong ones.
 */
const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[/\\])tests?[/\\]/i,
  /(^|[/\\])__tests__[/\\]/,
  /(^|[/\\])spec[/\\]/i,
  /[._-]test\.[a-z]+$/i,
  /[._-]spec\.[a-z]+$/i,
  /^test_.*\.py$/i,
  /Tests?\.(java|kt|cs|swift)$/,
];

export function isTestPath(relPath: string): boolean {
  const name = basename(relPath);
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(relPath) || pattern.test(name));
}

/**
 * Input beyond the root itself.
 *
 * Unusual among the providers: this one derives relations from facts other
 * providers produced rather than from source text. Passing the model in keeps
 * it from re-deriving symbols and call edges — and from disagreeing with the
 * providers that own them.
 */
export interface ModelView {
  readonly symbols: readonly SymbolRecord[];
  readonly callEdges: readonly CallEdgeRecord[];
}

/**
 * Derives relations for one root.
 *
 * A test symbol whose target cannot be resolved is still recorded, with an
 * unresolved provenance. An untraceable test is a finding about the codebase;
 * dropping it would make coverage look better than it is.
 */
export function deriveTestRelations(rootName: string, model: ModelView): readonly TestRelationRecord[] {
  const symbolsById = new Map<SymbolId, SymbolRecord>();
  for (const symbol of model.symbols) symbolsById.set(symbol.id, symbol);

  const testSymbols = model.symbols.filter((symbol) =>
    isTestPath(symbol.provenance.source.relPath),
  );
  if (testSymbols.length === 0) return [];

  const testIds = new Set(testSymbols.map((symbol) => symbol.id));
  const relations: TestRelationRecord[] = [];
  const seen = new Set<string>();
  const covering = new Set<SymbolId>();

  for (const edge of model.callEdges) {
    if (!testIds.has(edge.callerId)) continue;
    covering.add(edge.callerId);

    // A test calling another test is a helper, not coverage of production code.
    if (edge.calleeId !== null && testIds.has(edge.calleeId)) continue;

    const target = edge.calleeId === null ? null : symbolsById.get(edge.calleeId);
    const key = `${edge.callerId}>${edge.calleeId ?? edge.calleeName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    relations.push({
      rootName,
      testSymbolId: edge.callerId,
      targetSymbolId: edge.calleeId,
      targetName: target?.name ?? edge.calleeName,
      relation: "covers",
      provenance:
        edge.calleeId === null
          ? unresolved(edge.provenance.source, "the symbol this test exercises could not be resolved")
          : resolved(edge.provenance.source, "medium"),
    });
  }

  // A test that calls nothing resolvable still exists, and saying so is more
  // useful than omitting it from the picture entirely.
  for (const symbol of testSymbols) {
    if (covering.has(symbol.id)) continue;
    relations.push({
      rootName,
      testSymbolId: symbol.id,
      targetSymbolId: null,
      targetName: null,
      relation: "unknown",
      provenance: unresolved(
        symbol.provenance.source,
        "no call edge from this test reaches production code",
      ),
    });
  }

  return relations;
}
