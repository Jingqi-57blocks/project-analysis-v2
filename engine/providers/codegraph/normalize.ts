/**
 * Translates CodeGraph's vocabulary into the Structural Model's.
 *
 * The direction matters: the model was defined first, and this file bends
 * CodeGraph's shapes to fit it. Nothing here may push a vendor concept upward
 * into the model.
 *
 * Everything the model can hold is normalized, not only what today's reports
 * consume. Filtering at extraction is unrecoverable — a fact dropped here
 * cannot be recovered by any later stage without re-indexing every root.
 */

import { symbolId, type SymbolId } from "../../structural/identity.js";
import { declared, lineRef, unresolved, type Provenance } from "../../structural/provenance.js";
import type {
  ImportRecord,
  SourceFileRecord,
  SymbolKind,
  SymbolRecord,
  CallEdgeRecord,
} from "../../structural/code.js";
import type { RouteRecord } from "../../structural/boundaries.js";
import type { CodeGraphFile, CodeGraphNode, CodeGraphRelation } from "./cli.js";

/**
 * Node kinds that are not symbols in our sense and are handled separately.
 * Anything else — including a kind this adapter has never seen — becomes a
 * symbol, which is what lets an unfamiliar language degrade to an honest
 * label rather than being dropped.
 */
const NON_SYMBOL_KINDS: ReadonlySet<string> = new Set(["file", "import", "route"]);

/**
 * CodeGraph's spelling to ours, where they differ.
 *
 * Only genuine spelling differences are mapped. A kind absent from this table
 * passes through unchanged rather than being coerced to "unknown": the model's
 * symbol-kind union is open precisely so a Rust trait or a Swift protocol
 * keeps its own name instead of being forced into the nearest wrong one.
 */
const KIND_SPELLINGS: Readonly<Record<string, SymbolKind>> = {
  type_alias: "type-alias",
};

export function normalizeKind(kind: string): SymbolKind {
  return KIND_SPELLINGS[kind] ?? kind;
}

function provenanceFor(rootName: string, node: CodeGraphNode): Provenance {
  return node.startLine === null
    ? declared({
        rootName,
        relPath: node.filePath,
        startLine: null,
        endLine: null,
        startColumn: null,
        endColumn: null,
      })
    : declared({
        rootName,
        relPath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        startColumn: node.startColumn,
        endColumn: node.endColumn,
      });
}

export function nodeSymbolId(rootName: string, node: CodeGraphNode): SymbolId {
  return symbolId({
    rootName,
    relPath: node.filePath,
    kind: normalizeKind(node.kind),
    qualifiedName: node.qualifiedName ?? node.name,
    signature: node.signature ?? null,
  });
}

export function toSourceFile(rootName: string, file: CodeGraphFile): SourceFileRecord {
  return {
    rootName,
    relPath: file.path,
    language: file.language,
    provenance: declared({
      rootName,
      relPath: file.path,
      startLine: null,
      endLine: null,
      startColumn: null,
      endColumn: null,
    }),
  };
}

export function isSymbolNode(node: CodeGraphNode): boolean {
  return !NON_SYMBOL_KINDS.has(node.kind);
}

export function toSymbol(rootName: string, node: CodeGraphNode): SymbolRecord {
  return {
    id: nodeSymbolId(rootName, node),
    name: node.name,
    qualifiedName: node.qualifiedName,
    kind: normalizeKind(node.kind),
    // Go encodes visibility in capitalization rather than a keyword, so
    // CodeGraph reports null. "unknown" is the honest label — claiming
    // "public" from an uppercase initial would be our inference presented as
    // the provider's observation.
    visibility: node.visibility ?? "unknown",
    signature: node.signature ?? null,
    containerId: null,
    provenance: provenanceFor(rootName, node),
  };
}

export function toImport(rootName: string, node: CodeGraphNode): ImportRecord {
  return {
    rootName,
    relPath: node.filePath,
    specifier: node.name,
    // CodeGraph does not report where a specifier resolved to, so this stays
    // null rather than being guessed from path arithmetic.
    resolvedPath: null,
    importedNames: [],
    isTypeOnly: false,
    provenance: provenanceFor(rootName, node),
  };
}

/**
 * Splits CodeGraph's `"GET /users"` route name into method and path.
 *
 * A name with no leading method is treated as an all-methods route with a null
 * method, matching the model's decision not to use a `"*"` sentinel that every
 * consumer would have to special-case.
 */
export function parseRouteName(name: string): { method: string | null; path: string } {
  const match = /^([A-Z]+)\s+(.*)$/.exec(name);
  if (!match) return { method: null, path: name };
  return { method: match[1]!, path: match[2]! };
}

export function toRoute(rootName: string, node: CodeGraphNode): RouteRecord {
  const { method, path } = parseRouteName(node.name);
  return {
    rootName,
    method,
    path,
    // CodeGraph's route node does not name its handler symbol. Left null and
    // unresolved rather than guessed from proximity, which would attach
    // handlers to routes confidently and sometimes wrongly.
    handlerSymbolId: null,
    handlerName: null,
    middleware: [],
    provenance: provenanceFor(rootName, node),
  };
}

/**
 * Builds a call edge from a caller symbol to one of its callees.
 *
 * The callee is matched to a known symbol id where the target is in the
 * indexed set. When it is not — a call into a dependency, or a target
 * CodeGraph could not resolve — the edge is kept with a null `calleeId` and an
 * unresolved provenance. Dropping it would erase the fact that a call exists,
 * shrinking the graph exactly where the code is hardest to reason about.
 */
export function toCallEdge(
  rootName: string,
  callerId: SymbolId,
  callee: CodeGraphRelation,
  resolve: (relation: CodeGraphRelation) => SymbolId | null,
): CallEdgeRecord {
  const calleeId = resolve(callee);
  const source = lineRef(rootName, callee.filePath, callee.startLine ?? 1);

  return {
    callerId,
    calleeId,
    calleeName: callee.name,
    provenance: calleeId
      ? declared(source)
      : unresolved(source, "callee is outside the indexed source or could not be resolved"),
  };
}
