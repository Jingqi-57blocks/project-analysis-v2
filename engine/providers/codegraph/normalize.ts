/**
 * Translates CodeGraph's vocabulary into the model's. The direction matters:
 * the model was defined first, and nothing here may push a vendor concept
 * upward into it.
 *
 * Everything the model can hold is normalized, not only what today's reports
 * consume — filtering at extraction cannot be undone without re-indexing.
 */

import { symbolId, type SymbolId } from "../../structural/identity.js";
import { declared, fileRef, inferred, lineRef, unresolved, type Provenance } from "../../structural/provenance.js";
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
 * Handled separately. Anything else — including a kind never seen before —
 * becomes a symbol, so an unfamiliar language degrades to an honest label
 * rather than being dropped.
 */
const NON_SYMBOL_KINDS: ReadonlySet<string> = new Set(["file", "import", "route"]);

/**
 * Only genuine spelling differences. A kind absent here passes through
 * unchanged rather than being coerced to "unknown".
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
    // Go encodes visibility in capitalization, so CodeGraph reports null.
    // Deriving "public" from an uppercase initial would be our inference
    // presented as the provider's observation.
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
    // Not reported by CodeGraph; guessing via path arithmetic would be wrong.
    resolvedPath: null,
    importedNames: [],
    isTypeOnly: false,
    provenance: provenanceFor(rootName, node),
  };
}

/** A name with no leading method is an all-methods route, with a null method. */
export function parseRouteName(name: string): { method: string | null; path: string } {
  const match = /^([A-Z]+)\s+(.*)$/.exec(name);
  if (!match) return { method: null, path: name };
  return { method: match[1]!, path: match[2]! };
}

/**
 * CodeGraph reports the literal path at the registration site, not the path the
 * service serves. Measured against hand-verified ground truth: 13 of 15 routes
 * sit inside a router group, so `/authorize` is reported where the service
 * serves `/oauth/authorize` — a *wrong* fact, which survives review better than
 * an absent one.
 *
 * Hence `inferred` at low confidence, so nothing filtering on directly-observed
 * facts repeats a path that may be missing its prefix. Resolving prefixes needs
 * framework-aware traversal and belongs in a route-specific provider.
 */
export function toRoute(rootName: string, node: CodeGraphNode): RouteRecord {
  const { method, path } = parseRouteName(node.name);
  const source =
    node.startLine === null
      ? { rootName, relPath: node.filePath, startLine: null, endLine: null, startColumn: null, endColumn: null }
      : {
          rootName,
          relPath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          startColumn: node.startColumn,
          endColumn: node.endColumn,
        };

  return {
    rootName,
    method,
    path,
    // Not named by CodeGraph. Guessing from proximity would attach handlers to
    // routes confidently and sometimes wrongly.
    handlerSymbolId: null,
    handlerName: null,
    handlerCandidates: [],
    middleware: [],
    provenance: inferred(source, "low"),
  };
}

/**
 * An unresolvable callee keeps its edge with a null id and unresolved
 * provenance; dropping it would erase the fact that a call exists.
 */
export function toCallEdge(
  rootName: string,
  callerId: SymbolId,
  callee: CodeGraphRelation,
  resolve: (relation: CodeGraphRelation) => SymbolId | null,
): CallEdgeRecord {
  const calleeId = resolve(callee);
  // A null line stays null rather than becoming 1. The model documents
  // exactly this — an unknown location must not be faked into a real-looking
  // one that sends a reader to a line saying nothing.
  const source =
    callee.startLine === null
      ? fileRef(rootName, callee.filePath)
      : lineRef(rootName, callee.filePath, callee.startLine);

  return {
    callerId,
    calleeId,
    calleeName: callee.name,
    provenance: calleeId
      ? declared(source)
      : unresolved(source, "callee is outside the indexed source or could not be resolved"),
  };
}
