/**
 * The CodeGraph structural provider.
 *
 * Indexes a root, reads the index through the documented CLI, and normalizes
 * everything into the Structural Model. What it cannot supply is declared as a
 * capability gap rather than discovered later by noticing a thin report.
 */

import { relative } from "node:path";

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
import {
  CALLEE_LIMIT,
  NODE_LIMIT,
  VERIFIED_VERSION,
  calleesOf,
  codegraphVersion,
  ensureIndexed,
  listFiles,
  queryNodes,
  sharedIndexRoot,
  type CodeGraphFile,
  type CodeGraphNode,
  type CodeGraphRelation,
} from "./cli.js";
import {
  isSymbolNode,
  nodeSymbolId,
  toCallEdge,
  toImport,
  toRoute,
  toSourceFile,
  toSymbol,
} from "./normalize.js";

export const PROVIDER_ID = "codegraph";

export interface CodeGraphOptions {
  /**
   * Every root this run will analyze, so one index can cover them all.
   *
   * Given without it, the provider indexes inside each root as before — which
   * is still correct, just written into the repositories.
   */
  readonly roots?: readonly string[];

  /**
   * Whether to query callees per symbol.
   *
   * That loop is one subprocess per callable symbol and dominates extraction —
   * measured at 96% of a run. A report that needs entry points and structure
   * but not the call graph can skip it, and the provider then declares
   * call-edge support as none with the reason, so nothing mistakes the absence
   * for a codebase without calls.
   */
  readonly callEdges?: boolean;
}

/** Symbol kinds worth asking for callees. Querying every constant would multiply cost for no edges. */
const CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

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
      { kind: "source-file", language: ANY_LANGUAGE, support: "full", limits: [] },
      {
        kind: "symbol",
        language: ANY_LANGUAGE,
        support: "full",
        limits: [`at most ${NODE_LIMIT} nodes per root`],
      },
      {
        kind: "call-edge",
        language: ANY_LANGUAGE,
        support: callEdges ? "partial" : "none",
        limits: callEdges ? [
          "only functions and methods are queried for callees",
          // Measured against a real Go service: every edge came back resolved,
          // because CodeGraph only reports callees it has indexed. Calls into
          // third-party packages are therefore absent from the graph rather
          // than present-but-unresolved, which would otherwise read as a
          // codebase that never touches its dependencies.
          "only calls to indexed symbols are reported; calls into dependencies do not appear at all",
          "dynamic dispatch and reflection are reported as unresolved where they surface",
          "one subprocess call per callable symbol, so extraction time grows with symbol count",
          `at most ${CALLEE_LIMIT} callees are read per symbol; hitting the cap is recorded as a failure`,
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
      { kind: "reference", language: ANY_LANGUAGE, support: "none", limits: [] },
      { kind: "type-relation", language: ANY_LANGUAGE, support: "none", limits: [] },
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
    { kind: "reference", language: ANY_LANGUAGE, reason: "CodeGraph does not expose reference sites" },
    {
      kind: "type-relation",
      language: ANY_LANGUAGE,
      reason: "CodeGraph does not expose inheritance or interface conformance",
    },
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
  readonly files: readonly CodeGraphFile[];
}

function scopeNodes(nodes: readonly CodeGraphNode[], prefix: string): readonly CodeGraphNode[] {
  return nodes
    .filter((node) => node.filePath.startsWith(prefix))
    .map((node) => ({ ...node, filePath: node.filePath.slice(prefix.length) }));
}

function scopeFiles(files: readonly CodeGraphFile[], prefix: string): readonly CodeGraphFile[] {
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
}

function extractFrom(
  root: StructuralRootInput,
  options: CodeGraphOptions,
  shared: SharedIndex | null,
): Extraction {
  const failures: ExtractionFailure[] = [];

  let nodes: readonly CodeGraphNode[];
  let files: readonly CodeGraphFile[];

  if (shared !== null) {
    const prefix = `${relative(shared.parent, root.path)}/`;
    nodes = scopeNodes(shared.nodes, prefix);
    files = scopeFiles(shared.files, prefix);
  } else {
    ensureIndexed(root.path);
    nodes = queryNodes(root.path);
    files = listFiles(root.path);
  }

  // Inventory already decided what counts as project content. Honouring that
  // here keeps the provider from describing vendored code the project does
  // not own — CodeGraph indexes whatever directory it is pointed at, so the
  // filtering has to happen on the way out.
  const permitted = root.analyzedFiles.length > 0 ? new Set(root.analyzedFiles) : null;
  const included = (relPath: string): boolean => permitted === null || permitted.has(relPath);

  const usableNodes = nodes.filter((node) => included(node.filePath));

  const symbolNodes = usableNodes.filter(isSymbolNode);

  // A callee relation carries only a simple name and file, so resolution keys
  // on those. Two symbols in one file can share a simple name — `User.Save`
  // and `Account.Save` are both `Save` in `models.go` — and picking whichever
  // was indexed last would attach the call to an arbitrary one of them, then
  // record it as `declared`: a wrong fact asserted as directly observed.
  //
  // Ambiguous names are therefore marked and left unresolved. An edge that
  // says "calls something named Save, target ambiguous" is worth more than one
  // confidently naming the wrong function.
  const symbolsByName = new Map<string, SymbolId>();
  const ambiguousNames = new Set<string>();
  for (const node of symbolNodes) {
    const key = `${node.filePath}::${node.name}`;
    if (symbolsByName.has(key)) ambiguousNames.add(key);
    else symbolsByName.set(key, nodeSymbolId(root.name, node));
  }

  const resolveCallee = (relation: CodeGraphRelation): SymbolId | null => {
    const key = `${relation.filePath}::${relation.name}`;
    if (ambiguousNames.has(key)) return null;
    return symbolsByName.get(key) ?? null;
  };

  const callEdges = [];
  for (const node of options.callEdges === false ? [] : symbolNodes) {
    if (!CALLABLE_KINDS.has(node.kind)) continue;
    try {
      const callerId = nodeSymbolId(root.name, node);
      const callees = calleesOf(root.path, node.name);
      for (const callee of callees) {
        callEdges.push(toCallEdge(root.name, callerId, callee, resolveCallee));
      }
      // The query is capped, and a full page back means there were probably
      // more. Recorded rather than left silent: a hub function quietly losing
      // its edges past the cap would understate fan-out with no trace.
      if (callees.length >= CALLEE_LIMIT) {
        failures.push({
          scope: `${node.filePath}::${node.name}`,
          reason: `callee list reached the ${CALLEE_LIMIT} result cap, so further edges from this symbol were not read`,
        });
      }
    } catch (error) {
      // One symbol's callee query failing must not discard every other edge.
      failures.push({
        scope: `${node.filePath}::${node.name}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const isKind = (node: CodeGraphNode, kind: string): boolean => node.kind === kind;

  return {
    records: {
      ...emptyRecords(),
      "source-file": files.filter((f) => included(f.path)).map((f) => toSourceFile(root.name, f)),
      symbol: symbolNodes.map((node) => toSymbol(root.name, node)),
      import: usableNodes.filter((n) => isKind(n, "import")).map((n) => toImport(root.name, n)),
      route: usableNodes.filter((n) => isKind(n, "route")).map((n) => toRoute(root.name, n)),
      "call-edge": callEdges,
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

    const parent = sharedIndexRoot(options.roots ?? []);
    if (parent === null) {
      resolved = null;
      return resolved;
    }

    ensureIndexed(parent);
    resolved = { parent, nodes: queryNodes(parent), files: listFiles(parent) };
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
        return {
          providerId: PROVIDER_ID,
          providerVersion: installed ?? VERIFIED_VERSION,
          rootName: root.name,
          records: emptyRecords(),
          gaps: [...standingGaps(), ...versionGap],
          failures: [
            { scope: root.name, reason: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    },
  };
}
