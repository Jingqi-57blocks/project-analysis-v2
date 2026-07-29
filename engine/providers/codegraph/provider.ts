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
  queryNodes,
  sharedIndexRoot,
  withIndexLock,
  type CodeGraphNode,
  type CodeGraphRelation,
} from "./cli.js";
import {
  isSymbolNode,
  nodeSymbolId,
  toCallEdge,
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
      // Supplied by the inventory, which visited every file already.
      { kind: "source-file", language: ANY_LANGUAGE, support: "none", limits: [] },
      {
        kind: "symbol",
        language: ANY_LANGUAGE,
        support: "full",
        // The index covers the directory holding every root, so the cap is
        // shared across them and across whatever else sits beside them.
        limits: [`at most ${NODE_LIMIT} nodes across the indexed directory`],
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
    const key = calleeKey(node.filePath, node.name);
    if (symbolsByName.has(key)) ambiguousNames.add(key);
    else symbolsByName.set(key, nodeSymbolId(root.name, node));
  }

  const resolveCallee = (relation: CodeGraphRelation): SymbolId | null => {
    const key = calleeKey(relation.filePath, relation.name, prefix);
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
      const nodes = queryNodes(parent);
      return {
        parent,
        nodes,
        truncated: nodes.length >= NODE_LIMIT,
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
