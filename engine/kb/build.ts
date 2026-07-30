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
import { INDEX_DIRECTORY, isIndexed, sharedIndexRoot } from "../providers/codegraph/cli.js";
import { join } from "node:path";
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

/**
 * The reader that fills the code index, named here rather than at every caller.
 *
 * Keeps the vendor's name inside the one module that already knows it — a run
 * asking "did the indexer fail" should not have to know which tool the indexer
 * is.
 */
export { PROVIDER_ID as CODE_INDEX_PROVIDER_ID } from "../providers/codegraph/provider.js";

export interface ReaderSet {
  readonly structural: readonly StructuralProvider[];
  readonly data: readonly DataModelProvider[];
  readonly collectors: readonly SemanticCollector[];
}

export interface ReaderOptions {
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
  return sharedIndexRoot(rootPaths).path ?? null;
}

/**
 * Whether an index is at the place a run meant to put one.
 *
 * `codeIndexLocation` states an intention, computed before anything runs, and it
 * cannot know whether the indexer was installed, or crashed, or built nothing.
 * Reporting that intention as an accomplished write put a false claim about the
 * filesystem into the knowledge base and onto the terminal.
 *
 * Answered by `isIndexed`, which looks for the store rather than the directory —
 * see the reasoning there. Asking the *reader* instead was the previous attempt
 * and it failed in both directions: a benign truncation counts as a failure while
 * the index sits there holding a hundred thousand symbols, and a shell plus a
 * working indexer produces no failure at all.
 *
 * Presence, not freshness. A run reusing an index built earlier answers true,
 * which is what the note claims; whether this run refreshed it is a separate
 * question, and the extraction failures are where that lives.
 */
export function codeIndexPresent(path: string | null | undefined): boolean {
  return path !== null && path !== undefined && isIndexed(path);
}

/**
 * The path a run discloses, spelled once.
 *
 * The note and the terminal both name the index directory, and both used to build
 * that string themselves — two copies of the vendor's directory name sitting two
 * lines from a claim of a vendor boundary.
 */
export function codeIndexArtifact(parent: string): string {
  return join(parent, INDEX_DIRECTORY);
}
