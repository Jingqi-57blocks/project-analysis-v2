/**
 * Connects tests to the production code they exercise.
 *
 * Test files are identified by convention and framework imports; targets come
 * from the call edges the model already holds, so this reads the assembled
 * model rather than re-parsing source.
 *
 * CodeGraph declares no support for this kind, so it arrives as another
 * provider — the same composition rule used for manifests and outbound calls.
 */

import { basename, extname } from "node:path";

import { emptyRecords } from "../../structural/kinds.js";
import { resolved, unresolved } from "../../structural/provenance.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";
import type { CallEdgeRecord, SymbolRecord } from "../../structural/code.js";
import type { TestRelationRecord } from "../../structural/boundaries.js";
import type { SymbolId } from "../../structural/identity.js";

export const PROVIDER_ID = "test-relations";
export const PROVIDER_VERSION = "1.0.0";

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

export function testCapabilities(): ProviderCapabilities {
  return {
    declarations: [
      {
        kind: "test-relation",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "test files are identified by path and filename convention only",
          "relations follow existing call edges, so a test exercising code indirectly may be missed",
          "a project using an unrecognized test convention yields no relations rather than wrong ones",
        ],
      },
    ],
  };
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

/**
 * Files that look like tests, independent of any symbol extraction.
 *
 * Useful on its own: a project whose language no provider indexes still gets
 * an honest answer to "is there a test suite here at all".
 */
export function testFiles(root: StructuralRootInput): readonly string[] {
  return root.analyzedFiles.filter((relPath) => isTestPath(relPath) && extname(relPath) !== "");
}

export function createTestRelationProvider(model: ModelView): StructuralProvider {
  const capabilities = testCapabilities();

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => declaredKinds(capabilities),
    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),
    structuralCapabilities: () => capabilities,

    extract: (root: StructuralRootInput): StructuralContribution => {
      const relations = deriveTestRelations(root.name, model);
      const files = testFiles(root);

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: { ...emptyRecords(), "test-relation": relations },
        gaps:
          files.length > 0 && relations.length === 0
            ? [
                {
                  kind: "test-relation",
                  language: ANY_LANGUAGE,
                  reason: `${files.length} test files were found but no call edges reach them, so no relation could be derived`,
                },
              ]
            : [],
        failures: [],
      };
    },
  };
}
