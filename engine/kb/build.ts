/**
 * The readers this tool runs, and the one call that turns a workspace into
 * facts.
 *
 * Kept in one place because the set of providers is a property of the run, not
 * of any caller: analysis and preflight have to agree about which readers
 * exist, and they disagreed for as long as each built its own list.
 */

import { createManifestProvider } from "../providers/manifests/provider.js";
import { createSourceFileProvider } from "../providers/sourcefiles/provider.js";
import { createDeclarationProvider } from "../providers/symbols/provider.js";
import { languageOf } from "../text/ast.js";
import { createOutboundProvider } from "../providers/outbound/provider.js";
import { createConventionsProvider } from "../providers/conventions/provider.js";
import { createCodeGraphProvider } from "../providers/codegraph/provider.js";
import { sharedIndexRoot } from "../providers/codegraph/cli.js";
import { createFrameworkRoutesProvider } from "../providers/frameworkroutes/provider.js";
import { createUiCallsProvider } from "../providers/uicalls/provider.js";
import { createLogicProvider } from "../providers/logic/provider.js";
import { createDataUsageProvider } from "../datamodel/usage.js";
import { createSqlSchemaProvider } from "../datamodel/sql.js";
import { createOrmMigrationProvider } from "../datamodel/orm.js";
import { createGoModelProvider } from "../datamodel/gostructs.js";
import { createDocumentationCollector } from "../collectors/documentation.js";
import { createCodeTextCollector } from "../collectors/code.js";
import type { StructuralProvider } from "../structural/provider.js";
import type { DataModelProvider } from "../datamodel/types.js";
import type { SemanticCollector } from "../semantic/types.js";

export interface ReaderSet {
  readonly structural: readonly StructuralProvider[];
  readonly data: readonly DataModelProvider[];
  readonly collectors: readonly SemanticCollector[];
}

export interface ReaderOptions {
  /**
   * Where the code index may be written.
   *
   * CodeGraph writes into whatever directory it is pointed at and offers no
   * flag to relocate that, so choosing a location and choosing what gets
   * indexed are the same choice. Naming a directory that does not contain the
   * roots means no symbols from it — declared as a gap, not left as silence.
   */
  readonly indexRoot?: string;
  /** Skip the code index entirely, and declare the resulting absence. */
  readonly noCodeIndex?: boolean;
  /** Accept a code index that cannot be read as verified, and the missing call graph with it. */
  readonly allowDegraded?: boolean;
  /**
   * Take symbols and imports from the code index alone.
   *
   * The default partitions them: CodeGraph skips every file the local AST can
   * parse, and the declaration reader supplies those. That is not a small
   * split — on a Go/TypeScript project the local reader supplies *every*
   * symbol and import, and CodeGraph supplies none. The partition exists
   * because two readers describing one function under different identities is
   * not agreement: the ids differ, both records survive, and the linking stage
   * reads two symbols of one name as ambiguous. Handler resolution measured
   * 438 with the split and 38 without it.
   *
   * This removes the ambiguity from the other side — one reader, so nothing to
   * disagree with. Whether that costs anything is what the parity harness
   * measures; until it is answered, the default stands.
   */
  readonly codegraphSymbolsOnly?: boolean;
}

/**
 * Every reader, for a workspace with these roots.
 *
 * CodeGraph imports nodes and edges from one version-gated batch read. This
 * preserves the call graph needed by generic entry tracing without the former
 * one-subprocess-per-symbol cost.
 */
export function defaultReaders(
  rootPaths: readonly string[],
  options: ReaderOptions = {},
): ReaderSet {
  const codeIndex = options.noCodeIndex === true
    ? []
    : [
        createCodeGraphProvider({
          callEdges: true,
          roots: [...rootPaths],
          // The declaration reader has these already; it and CodeGraph
          // describe one function differently, and both surviving makes the
          // pair ambiguous rather than agreed. Unrestricted only when the
          // declaration reader is not there to disagree with.
          ...(options.codegraphSymbolsOnly === true
            ? {}
            : { skipSymbolsIn: (relPath: string) => languageOf(relPath) !== null }),
          ...(options.indexRoot === undefined ? {} : { indexRoot: options.indexRoot }),
          ...(options.allowDegraded === true ? { allowDegraded: true } : {}),
        }),
      ];

  return {
    structural: [
      createSourceFileProvider(),
      ...(options.codegraphSymbolsOnly === true ? [] : [createDeclarationProvider()]),
      createManifestProvider(),
      createOutboundProvider(),
      createConventionsProvider(),
      createFrameworkRoutesProvider(),
      createUiCallsProvider(),
      createDataUsageProvider(),
      createLogicProvider(),
      ...codeIndex,
    ],
    data: [createSqlSchemaProvider(), createOrmMigrationProvider(), createGoModelProvider()],
    collectors: [createDocumentationCollector(), createCodeTextCollector()],
  };
}

/**
 * The directory a run will write its code index into, before it writes it.
 *
 * Stated rather than discovered. Everything else this tool does to an analyzed
 * project is a read, and a user told that has no way to find out otherwise
 * except by noticing the directory afterwards.
 */
export function codeIndexLocation(
  rootPaths: readonly string[],
  options: ReaderOptions = {},
): string | null {
  if (options.noCodeIndex === true) return null;
  return options.indexRoot ?? sharedIndexRoot(rootPaths);
}
