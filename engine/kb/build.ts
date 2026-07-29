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
}

/**
 * Every reader, for a workspace with these roots.
 *
 * CodeGraph runs without call-edge extraction: that loop is one subprocess per
 * callable symbol and dominates the cost of a run, while entry points and
 * structure — what everything downstream actually needs — come from two cheap
 * queries. The omission is declared as a capability limit, so nothing reads it
 * as a codebase without calls.
 */
export function defaultReaders(
  rootPaths: readonly string[],
  options: ReaderOptions = {},
): ReaderSet {
  const codeIndex = options.noCodeIndex === true
    ? []
    : [
        createCodeGraphProvider({
          callEdges: false,
          roots: [...rootPaths],
          // The declaration reader has these already; it and CodeGraph
          // describe one function differently, and both surviving makes the
          // pair ambiguous rather than agreed.
          skipSymbolsIn: (relPath) => languageOf(relPath) !== null,
          ...(options.indexRoot === undefined ? {} : { indexRoot: options.indexRoot }),
        }),
      ];

  return {
    structural: [
      createSourceFileProvider(),
      createDeclarationProvider(),
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
