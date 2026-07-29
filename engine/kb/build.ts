/**
 * The readers this tool runs, and the one call that turns a workspace into
 * facts.
 *
 * Kept in one place because the set of providers is a property of the run, not
 * of any caller: analysis and preflight have to agree about which readers
 * exist, and they disagreed for as long as each built its own list.
 */

import { createManifestProvider } from "../providers/manifests/provider.js";
import { createOutboundProvider } from "../providers/outbound/provider.js";
import { createConventionsProvider } from "../providers/conventions/provider.js";
import { createCodeGraphProvider } from "../providers/codegraph/provider.js";
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

/**
 * Every reader, for a workspace with these roots.
 *
 * CodeGraph runs without call-edge extraction: that loop is one subprocess per
 * callable symbol and dominates the cost of a run, while entry points and
 * structure — what everything downstream actually needs — come from two cheap
 * queries. The omission is declared as a capability limit, so nothing reads it
 * as a codebase without calls.
 *
 * Its index lives beside the repositories rather than inside each of them,
 * which is what keeps the analyzed source untouched.
 */
export function defaultReaders(rootPaths: readonly string[]): ReaderSet {
  return {
    structural: [
      createManifestProvider(),
      createOutboundProvider(),
      createConventionsProvider(),
      createFrameworkRoutesProvider(),
      createUiCallsProvider(),
      createDataUsageProvider(),
      createLogicProvider(),
      createCodeGraphProvider({ callEdges: false, roots: [...rootPaths] }),
    ],
    data: [createSqlSchemaProvider(), createOrmMigrationProvider(), createGoModelProvider()],
    collectors: [createDocumentationCollector(), createCodeTextCollector()],
  };
}
