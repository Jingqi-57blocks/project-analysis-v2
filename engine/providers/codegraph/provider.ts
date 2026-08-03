/**
 * The CodeGraph structural provider.
 *
 * Indexes a root, reads the index through the documented CLI, and normalizes
 * everything into the Structural Model. What it cannot supply is declared as a
 * capability gap rather than discovered later by noticing a thin report.
 */

import { basename, join, relative } from "node:path";

import { emptyRecords, type StructuralRecords } from "../../structural/kinds.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type CapabilityGap,
  type ExtractionFailure,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";
import type { SymbolId } from "../../structural/identity.js";
import { declared, fileRef, lineRef, unresolved } from "../../structural/provenance.js";
import type { CallEdgeRecord, ReferenceRecord, TypeRelationRecord } from "../../structural/code.js";
import {
  NODE_LIMIT,
  VERIFIED_VERSION,
  codegraphVersion,
  ensureIndexed,
  queryNodes,
  sharedIndexRoot,
  withIndexLock,
  type CodeGraphNode,
} from "./cli.js";
import { readBatchDb } from "./batchdb.js";
import type { CodeGraphNodeRecord, CodeGraphSnapshot } from "./batch.js";
import {
  isSymbolNode,
  nodeSymbolId,
  toImport,
  toRoute,
  toSymbol,
} from "./normalize.js";

export const PROVIDER_ID = "codegraph";

export interface CodeGraphOptions {
  /**
   * Every root this run will analyze, so one index can cover them all.
   *
   * Required in practice: the index is written into the directory CodeGraph
   * is pointed at, and without the roots there is no way to choose one outside
   * them. A provider built without this supplies nothing and says why, rather
   * than writing into source it promised not to touch.
   */
  readonly roots?: readonly string[];

  /**
   * Index here, exactly. Named by a caller who has chosen where the cache may
   * be written, so it is used as given rather than run through the
   * common-ancestor rule — which would put it one directory higher than asked.
   */
  readonly indexRoot?: string;

  /**
   * Whether to import call edges from the batch index.
   *
   * A caller can still omit the graph for a deliberately structural-only run.
   * The provider then declares call-edge support as none, so an empty edge set
   * cannot be mistaken for a codebase without calls.
   */
  readonly callEdges?: boolean;

  /**
   * Leave symbols in files another reader already parsed.
   *
   * Two providers describing one function under different identities is not a
   * merge — the ids differ, so both records survive, and the linking stage
   * then sees two symbols of one name and refuses the match as ambiguous.
   * Measured on WCP-V2: handler resolution fell from 438 to 38. Partitioning
   * by file is what lets both readers contribute without competing.
   */
  readonly skipSymbolsIn?: (relPath: string) => boolean;
}

/**
 * What this provider can and cannot supply.
 *
 * The gaps are as important as the support. Each one is a declared fact, so an
 * empty result for that kind reads as "nobody looked" rather than "the project
 * has none" — a distinction that decides whether a reader treats emptiness as
 * a finding.
 */
export function codegraphCapabilities(options: CodeGraphOptions = {}): ProviderCapabilities {
  const callEdges = options.callEdges ?? true;

  return {
    declarations: [
      // Supplied by the inventory, which visited every file already.
      { kind: "source-file", language: ANY_LANGUAGE, support: "none", limits: [] },
      {
        kind: "symbol",
        language: ANY_LANGUAGE,
        support: "full",
        limits: [
          "all nodes are read in one pass from the version-gated batch index",
          `the CLI fallback is limited to ${NODE_LIMIT} nodes across the indexed directory`,
        ],
      },
      {
        kind: "call-edge",
        language: ANY_LANGUAGE,
        support: callEdges ? "partial" : "none",
        limits: callEdges ? [
          "all resolved call edges are read in one pass from the version-gated CodeGraph index",
          // Measured against a real Go service: every edge came back resolved,
          // because CodeGraph only reports callees it has indexed. Calls into
          // third-party packages are therefore absent from the graph rather
          // than present-but-unresolved, which would otherwise read as a
          // codebase that never touches its dependencies.
          "only calls to indexed symbols are reported; calls into dependencies do not appear at all",
          "dynamic dispatch and reflection are reported as unresolved where they surface",
          "dynamic dispatch and reflection remain unresolved where CodeGraph cannot establish a target",
        ] : ["call-edge extraction was switched off for this run"],
      },
      {
        kind: "import",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: ["import specifiers are not resolved to files", "imported names are not itemized"],
      },
      {
        kind: "route",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "framework router-group prefixes are not resolved, so paths may be incomplete",
          "routes are not linked to their handler symbols",
          "routes registered through a wrapper or closure may be missed entirely",
        ],
      },
      // Declared as unsupported rather than left silent, so the assembler and
      // the coverage matrix can tell a refusal from an oversight.
      { kind: "export", language: ANY_LANGUAGE, support: "none", limits: [] },
      {
        kind: "reference",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: ["resolved reference and instantiation edges from the CodeGraph batch index"],
      },
      {
        kind: "type-relation",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: ["extends and implements edges observed by CodeGraph"],
      },
      { kind: "package-dependency", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "build-target", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "module-containment", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "outbound-call", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "external-call", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "data-access", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "auth-annotation", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "test-relation", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "validation-rule", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "transaction-boundary", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "error-handling", language: ANY_LANGUAGE, support: "none", limits: [] },
    ],
  };
}

/** Gaps reported on every run, naming the capability responsible for each absence. */
function standingGaps(): readonly CapabilityGap[] {
  return [
    { kind: "export", language: ANY_LANGUAGE, reason: "CodeGraph does not expose export records" },
    {
      kind: "package-dependency",
      language: ANY_LANGUAGE,
      reason: "supplied by the manifest reader, not by this provider",
    },
    {
      kind: "build-target",
      language: ANY_LANGUAGE,
      reason: "supplied by the manifest reader, not by this provider",
    },
    {
      kind: "module-containment",
      language: ANY_LANGUAGE,
      reason: "supplied by the manifest reader, not by this provider",
    },
    {
      kind: "outbound-call",
      language: ANY_LANGUAGE,
      reason: "supplied by the outbound-call detector, not by this provider",
    },
    {
      kind: "source-file",
      language: ANY_LANGUAGE,
      reason:
        "supplied by the inventory, which visited every file and knows why any was skipped",
    },
  ];
}

function callEdgeGap(options: CodeGraphOptions): readonly CapabilityGap[] {
  return options.callEdges === false
    ? [
        {
          kind: "call-edge",
          language: ANY_LANGUAGE,
          reason:
            "call-edge extraction was switched off for this run, so nothing could be traced through the call graph",
        },
      ]
    : [];
}

interface Extraction {
  readonly records: StructuralRecords;
  readonly failures: readonly ExtractionFailure[];
}

/**
 * One index covering every root, when they share a parent.
 *
 * The alternative is an index inside each root, which is what this did before:
 * five directories written into five repositories. Indexing the parent instead
 * writes nothing into any of them.
 *
 * Scoping is ours to do. A query against the parent returns the whole
 * workspace whatever path is passed — measured: asking for one root came back
 * with nine of two thousand nodes from it — so records are partitioned here by
 * the prefix each root contributes, and the prefix is stripped so every path
 * stays relative to its own root exactly as before.
 */
interface SharedIndex {
  readonly parent: string;
  readonly nodes: readonly CodeGraphNode[];
  /** True when the query came back full, so there were probably more nodes. */
  readonly truncated: boolean;
  /** One read of every CodeGraph edge; null only when the version/schema gate rejects it. */
  readonly batch: CodeGraphSnapshot | null;
  readonly batchFailure: string | null;
}

function batchNode(node: CodeGraphNodeRecord): CodeGraphNode {
  return {
    id: node.nativeId,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.metadata.qualifiedName ?? null,
    filePath: node.filePath,
    language: node.metadata.language ?? null,
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: null,
    endColumn: null,
    signature: node.metadata.signature ?? null,
    visibility: node.metadata.visibility ?? null,
    isExported: node.metadata.isExported === "1" || node.metadata.isExported === "true",
  };
}

interface ScopedBatchNode {
  readonly rootName: string;
  readonly node: CodeGraphNode;
}

function scopedBatchNode(
  node: CodeGraphNodeRecord,
  parent: string,
  roots: readonly string[],
  current: StructuralRootInput,
): ScopedBatchNode | null {
  const ordered = [...roots].sort((a, b) => b.length - a.length);
  for (const rootPath of ordered) {
    const prefix = `${relative(parent, rootPath)}/`;
    if (!node.filePath.startsWith(prefix)) continue;
    return {
      rootName: rootPath === current.path ? current.name : basename(rootPath),
      node: { ...batchNode(node), filePath: node.filePath.slice(prefix.length) },
    };
  }
  return null;
}

function canonicalNodeId(
  scoped: ScopedBatchNode,
  options: CodeGraphOptions,
): SymbolId {
  // The in-process declaration reader deliberately omits signatures. Where it
  // owns a file, use that exact identity for batch edges too; otherwise the
  // edge points at a second, signature-bearing id that is absent from the
  // merged model and every trace silently stops.
  const signature = options.skipSymbolsIn?.(scoped.node.filePath) === true
    ? null
    : (scoped.node.signature ?? null);
  return nodeSymbolId(scoped.rootName, { ...scoped.node, signature });
}

/** Normalize every batch call edge for one root without an N+1 CLI loop. */
export function batchCallEdges(
  snapshot: CodeGraphSnapshot,
  parent: string,
  roots: readonly string[],
  current: StructuralRootInput,
  options: CodeGraphOptions,
): readonly CallEdgeRecord[] {
  return batchRelations(snapshot, parent, roots, current, options).callEdges;
}

export interface BatchRelations {
  readonly callEdges: readonly CallEdgeRecord[];
  readonly references: readonly ReferenceRecord[];
  readonly typeRelations: readonly TypeRelationRecord[];
}

/** Import calls, instantiations/references and type relations from one batch read. */
export function batchRelations(
  snapshot: CodeGraphSnapshot,
  parent: string,
  roots: readonly string[],
  current: StructuralRootInput,
  options: CodeGraphOptions,
): BatchRelations {
  const rawById = new Map(snapshot.nodes.map((node) => [node.nativeId, node] as const));
  const scopedById = new Map<string, ScopedBatchNode>();
  for (const node of snapshot.nodes) {
    const scoped = scopedBatchNode(node, parent, roots, current);
    if (scoped !== null) scopedById.set(node.nativeId, scoped);
  }
  const unresolvedBySource = new Map<string, string[]>();
  for (const ref of snapshot.unresolvedReferences) {
    const list = unresolvedBySource.get(ref.fromNativeId) ?? [];
    list.push(ref.name);
    unresolvedBySource.set(ref.fromNativeId, list);
  }

  const currentPrefix = `${relative(parent, current.path)}/`;
  const permitted = current.analyzedFiles.length === 0 ? null : new Set(current.analyzedFiles);
  const callEdges: CallEdgeRecord[] = [];
  const references: ReferenceRecord[] = [];
  const typeRelations: TypeRelationRecord[] = [];
  for (const edge of snapshot.edges) {
    const sourceRaw = rawById.get(edge.fromNativeId);
    if (sourceRaw === undefined || !sourceRaw.filePath.startsWith(currentPrefix)) continue;
    const sourceRelPath = sourceRaw.filePath.slice(currentPrefix.length);
    if (permitted !== null && !permitted.has(sourceRelPath)) continue;
    const caller = scopedById.get(edge.fromNativeId);
    if (caller === undefined || !isSymbolNode(caller.node)) continue;
    const target = edge.toNativeId === null ? undefined : scopedById.get(edge.toNativeId);
    const resolvedTarget = target !== undefined && isSymbolNode(target.node) ? target : null;
    const source = edge.startLine === null
      ? fileRef(current.name, sourceRelPath)
      : lineRef(current.name, sourceRelPath, edge.startLine);
    const unresolvedName = unresolvedBySource.get(edge.fromNativeId)?.[0];
    const callerId = canonicalNodeId(caller, options);
    const targetId = resolvedTarget === null ? null : canonicalNodeId(resolvedTarget, options);
    if (edge.kind === "calls" || edge.kind === "call") {
      callEdges.push({
        callerId,
        calleeId: targetId,
        calleeName: resolvedTarget?.node.name ?? unresolvedName ?? "unresolved callee",
        provenance: resolvedTarget === null
          ? unresolved(source, "CodeGraph recorded the call but did not resolve its target inside the analyzed roots")
          : declared(source),
      });
      continue;
    }
    if ((edge.kind === "references" || edge.kind === "reference" || edge.kind === "instantiates") && targetId !== null) {
      references.push({
        fromSymbolId: callerId,
        symbolId: targetId,
        kind: edge.kind === "instantiates" ? "instantiate" : "reference",
        source,
        provenance: declared(source),
      });
      continue;
    }
    if (edge.kind === "implements" || edge.kind === "extends") {
      typeRelations.push({
        subtypeId: callerId,
        supertypeId: targetId,
        supertypeName: resolvedTarget?.node.name ?? unresolvedName ?? "unresolved type",
        relation: edge.kind,
        provenance: targetId === null
          ? unresolved(source, "CodeGraph recorded the type relation but did not resolve its target inside the analyzed roots")
          : declared(source),
      });
    }
  }
  return { callEdges, references, typeRelations };
}

/**
 * One spelling for both sides of the callee join.
 *
 * Symbols arrive with the root prefix already stripped; callee relations come
 * straight from a query against the index root and still carry it. Built
 * separately, the two sides never match — every edge resolves to null and is
 * published as "calls something named X, target could not be established",
 * which is untrue of the source and comes with no failure beside it.
 */
export function calleeKey(relPath: string, name: string, prefix = ""): string {
  const path = prefix !== "" && relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
  return `${path}::${name}`;
}

function scopeNodes(nodes: readonly CodeGraphNode[], prefix: string): readonly CodeGraphNode[] {
  return nodes
    .filter((node) => node.filePath.startsWith(prefix))
    .map((node) => ({ ...node, filePath: node.filePath.slice(prefix.length) }));
}


function extractFrom(
  root: StructuralRootInput,
  options: CodeGraphOptions,
  shared: SharedIndex | null,
): Extraction {
  const failures: ExtractionFailure[] = [];

  let nodes: readonly CodeGraphNode[];

  if (shared === null) {
    // Indexing inside the root would be the only alternative, and analyzed
    // source is never written to. Failing here degrades one provider and says
    // why; writing the index would break a guarantee the whole tool rests on.
    throw new Error(
      `No directory outside "${root.name}" can hold the index, so no index was built for it. ` +
        "Analyze from a directory that contains the root rather than from a filesystem root.",
    );
  }

  const prefix = `${relative(shared.parent, root.path)}/`;
  nodes = scopeNodes(shared.nodes, prefix);

  if (shared.truncated) {
    failures.push({
      scope: root.name,
      reason: `the index query returned its ${NODE_LIMIT}-node maximum, so some of this root's symbols were not read`,
    });
  }

  // Inventory already decided what counts as project content. Honouring that
  // here keeps the provider from describing vendored code the project does
  // not own — CodeGraph indexes whatever directory it is pointed at, so the
  // filtering has to happen on the way out.
  const permitted = root.analyzedFiles.length > 0 ? new Set(root.analyzedFiles) : null;
  const included = (relPath: string): boolean => permitted === null || permitted.has(relPath);

  const usableNodes = nodes.filter((node) => included(node.filePath));

  const symbolNodes = usableNodes.filter(isSymbolNode);

  const relations = shared.batch === null
    ? { callEdges: [], references: [], typeRelations: [] }
    : batchRelations(shared.batch, shared.parent, options.roots ?? [], root, options);
  const callEdges = options.callEdges === false ? [] : relations.callEdges;
  if (options.callEdges !== false && shared.batch === null) {
    failures.push({
      scope: root.name,
      reason: `CodeGraph batch edge import failed: ${shared.batchFailure ?? "unknown batch failure"}`,
    });
  }

  const isKind = (node: CodeGraphNode, kind: string): boolean => node.kind === kind;

  return {
    records: {
      ...emptyRecords(),
      // Only where nobody else read the file: overlapping symbols carry
      // different identities, and the linking stage reads two of one name as
      // ambiguous rather than as agreement.
      symbol: symbolNodes
        .filter((node) => options.skipSymbolsIn?.(node.filePath) !== true)
        .map((node) => toSymbol(root.name, node)),
      import: usableNodes
        .filter((n) => isKind(n, "import") && options.skipSymbolsIn?.(n.filePath) !== true)
        .map((n) => toImport(root.name, n)),
      route: usableNodes.filter((n) => isKind(n, "route")).map((n) => toRoute(root.name, n)),
      "call-edge": callEdges,
      reference: relations.references,
      "type-relation": relations.typeRelations,
    },
    failures,
  };
}

export function createCodeGraphProvider(options: CodeGraphOptions = {}): StructuralProvider {
  const capabilities = codegraphCapabilities(options);

  // Built once on the first root that needs it, then reused: the index covers
  // every root, so building it per root would repeat the same work N times.
  let resolved: SharedIndex | null | undefined;
  const sharedIndex = (): SharedIndex | null => {
    if (resolved !== undefined) return resolved;

    const parent = options.indexRoot ?? sharedIndexRoot(options.roots ?? []);
    if (parent === null) {
      resolved = null;
      return resolved;
    }

    // Indexing and reading happen under one lock. Reading between another
    // run's rebuild and its completion returns nothing, which would be
    // reported as a codebase with no symbols rather than as a clash.
    resolved = withIndexLock(parent, () => {
      ensureIndexed(parent);
      const outcome = readBatchDb(join(parent, ".codegraph", "codegraph.db"), parent);
      const nodes = outcome.ok ? outcome.snapshot.nodes.map(batchNode) : queryNodes(parent);
      return {
        parent,
        nodes,
        truncated: outcome.ok ? outcome.snapshot.truncation.truncated : nodes.length >= NODE_LIMIT,
        batch: outcome.ok ? outcome.snapshot : null,
        batchFailure: outcome.ok ? null : JSON.stringify(outcome.degradation),
      };
    });
    return resolved;
  };

  return {
    id: PROVIDER_ID,
    version: VERIFIED_VERSION,

    capabilities: () => declaredKinds(capabilities),

    preflight: (): PreflightResult => {
      const installed = codegraphVersion();
      if (installed === null) {
        return { available: false, reason: "codegraph is not installed or not on PATH" };
      }
      return { available: true, version: installed };
    },

    structuralCapabilities: () => capabilities,

    extract: (root: StructuralRootInput): StructuralContribution => {
      const installed = codegraphVersion();

      // A version other than the verified one is reported as a gap rather than
      // refused: the adapter probably still works, and refusing outright would
      // block a run over a patch bump. Recording it means a surprising result
      // can be traced back to a version nobody verified.
      const versionGap: readonly CapabilityGap[] =
        installed !== null && installed !== VERIFIED_VERSION
          ? [
              {
                kind: "symbol",
                language: ANY_LANGUAGE,
                reason: `running CodeGraph ${installed}, verified against ${VERIFIED_VERSION}`,
              },
            ]
          : [];

      try {
        const extraction = extractFrom(root, options, sharedIndex());
        return {
          providerId: PROVIDER_ID,
          providerVersion: installed ?? VERIFIED_VERSION,
          rootName: root.name,
          records: extraction.records,
          gaps: [...standingGaps(), ...callEdgeGap(options), ...versionGap],
          failures: extraction.failures,
        };
      } catch (error) {
        // Indexing or querying failed outright. Returning an empty
        // contribution with the reason recorded degrades only this provider,
        // leaving any other provider's findings intact.
        //
        // Every kind this provider claims becomes a gap. Without that, the
        // standing declaration still says "symbol: full support" and the
        // accounting reads "supplied, 0 records" — a project reported as
        // having no code, from a run where nothing could be read.
        const reason = error instanceof Error ? error.message : String(error);
        const failedGaps: CapabilityGap[] = capabilities.declarations
          .filter((declaration) => declaration.support !== "none")
          .map((declaration) => ({
            kind: declaration.kind,
            language: declaration.language,
            reason: `extraction failed for ${root.name}: ${reason}`,
          }));

        return {
          providerId: PROVIDER_ID,
          providerVersion: installed ?? VERIFIED_VERSION,
          rootName: root.name,
          records: emptyRecords(),
          gaps: [...failedGaps, ...standingGaps(), ...versionGap],
          failures: [{ scope: root.name, reason }],
        };
      }
    },
  };
}
