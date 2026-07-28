/**
 * The CodeGraph structural provider.
 *
 * Indexes a root, reads the index through the documented CLI, and normalizes
 * everything into the Structural Model. What it cannot supply is declared as a
 * capability gap rather than discovered later by noticing a thin report.
 */

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
  NODE_LIMIT,
  VERIFIED_VERSION,
  calleesOf,
  codegraphVersion,
  ensureIndexed,
  listFiles,
  queryNodes,
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
export function codegraphCapabilities(): ProviderCapabilities {
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
        support: "partial",
        limits: [
          "only functions and methods are queried for callees",
          // Measured against a real Go service: every edge came back resolved,
          // because CodeGraph only reports callees it has indexed. Calls into
          // third-party packages are therefore absent from the graph rather
          // than present-but-unresolved, which would otherwise read as a
          // codebase that never touches its dependencies.
          "only calls to indexed symbols are reported; calls into dependencies do not appear at all",
          "dynamic dispatch and reflection are reported as unresolved where they surface",
          "one subprocess call per callable symbol, so extraction time grows with symbol count",
        ],
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

interface Extraction {
  readonly records: StructuralRecords;
  readonly failures: readonly ExtractionFailure[];
}

function extractFrom(root: StructuralRootInput): Extraction {
  const failures: ExtractionFailure[] = [];

  ensureIndexed(root.path);

  const nodes = queryNodes(root.path);
  const files = listFiles(root.path);

  // Inventory already decided what counts as project content. Honouring that
  // here keeps the provider from describing vendored code the project does
  // not own — CodeGraph indexes whatever directory it is pointed at, so the
  // filtering has to happen on the way out.
  const permitted = root.analyzedFiles.length > 0 ? new Set(root.analyzedFiles) : null;
  const included = (relPath: string): boolean => permitted === null || permitted.has(relPath);

  const usableNodes = nodes.filter((node) => included(node.filePath));

  const symbolNodes = usableNodes.filter(isSymbolNode);
  const symbolsByName = new Map<string, SymbolId>();
  for (const node of symbolNodes) {
    // Last write wins; ambiguous names are resolved conservatively below by
    // requiring the file path to match as well.
    symbolsByName.set(`${node.filePath}::${node.name}`, nodeSymbolId(root.name, node));
  }

  const resolveCallee = (relation: CodeGraphRelation): SymbolId | null =>
    symbolsByName.get(`${relation.filePath}::${relation.name}`) ?? null;

  const callEdges = [];
  for (const node of symbolNodes) {
    if (!CALLABLE_KINDS.has(node.kind)) continue;
    try {
      const callerId = nodeSymbolId(root.name, node);
      for (const callee of calleesOf(root.path, node.name)) {
        callEdges.push(toCallEdge(root.name, callerId, callee, resolveCallee));
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

export function createCodeGraphProvider(): StructuralProvider {
  const capabilities = codegraphCapabilities();

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
        const extraction = extractFrom(root);
        return {
          providerId: PROVIDER_ID,
          providerVersion: installed ?? VERIFIED_VERSION,
          rootName: root.name,
          records: extraction.records,
          gaps: [...standingGaps(), ...versionGap],
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
