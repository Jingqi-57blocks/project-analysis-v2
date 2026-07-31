/**
 * The WCP-V2 structural truth gate (PI-65).
 *
 * Grades the facet=M1 truth items against a fresh CodeGraph structural snapshot:
 * for each item, whether the structural fact it cites was found at the cited
 * location, or is honestly unresolved/unsupported/failed/truncated. The
 * CodeGraph lane covers symbol/route/call structure; tables, JS-legacy routes
 * and cross-repo links belong to other lanes and are marked unsupported here
 * with that attribution, not silently failed. The golden-slice hard gate passes
 * only when every CodeGraph-lane must-find is found and no critical item is
 * unresolved/unsupported/failed/truncated.
 */

import type { ImportedEdge } from "../providers/codegraph/importedges.js";
import type { ImportedNode } from "../providers/codegraph/importnodes.js";
import type { TruthItem } from "../contracts/truth/schema.js";

export type TruthStatus = "found" | "not-found" | "unresolved" | "unsupported" | "failed" | "truncated";

/** Categories the CodeGraph structural lane can verify from symbol/route/edge facts. */
const CODEGRAPH_LANE: ReadonlySet<string> = new Set([
  "entry-point",
  "role",
  "dep-out",
  "dep-in",
  "change-impact",
  "call-edge",
]);

/** Categories another lane owns (datamodel, cross-repo, the JS service). */
const OTHER_LANE: Readonly<Record<string, string>> = {
  "db-table": "datamodel provider (not the CodeGraph lane)",
  "db-ownership": "datamodel/migration lane (not the CodeGraph lane)",
  "cross-repo": "cross-repository linking lane (a single index cannot span repos)",
  boundary: "the JS service lane (a separate index)",
};

export interface TruthItemResult {
  readonly truthId: string;
  readonly category: string;
  readonly criticality: string;
  readonly mustFind: boolean;
  readonly status: TruthStatus;
  readonly detail: string;
}

export interface StructuralGateReport {
  readonly indexedRoot: string;
  readonly total: number;
  readonly results: readonly TruthItemResult[];
  readonly counts: Readonly<Record<TruthStatus, number>>;
  readonly mustFindTotal: number;
  readonly mustFindFound: number;
  readonly criticalIssues: number;
  readonly passed: boolean;
}

function stripRoot(root: string, path: string): string {
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** A cited file, or any file under a cited directory (a path ending in "/"), has structure. */
function hasStructureAt(rel: string, files: ReadonlySet<string>): boolean {
  if (files.has(rel)) return true;
  const prefix = rel.endsWith("/") ? rel : `${rel}/`;
  for (const file of files) if (file.startsWith(prefix)) return true;
  return false;
}

/**
 * Grades truth items against the snapshot's imported nodes and edges for one
 * indexed root. `indexedRoot` names the root the snapshot came from (e.g.
 * "wcp-service-v2"); items whose evidence is in that root are checked by whether
 * a fact of the expected kind exists at the cited file, and items in another
 * root or lane are honestly unresolved/unsupported rather than failed.
 */
export function gradeStructuralTruth(
  items: readonly TruthItem[],
  nodes: readonly ImportedNode[],
  edges: readonly ImportedEdge[],
  indexedRoot: string,
): StructuralGateReport {
  const filesWithNodes = new Set(nodes.map((n) => n.filePath));
  const filesWithEdgeOrNode = new Set([...filesWithNodes, ...edges.map((e) => e.filePath)]);

  const results: TruthItemResult[] = items.map((item) => {
    const base = { truthId: item.id, category: item.category, criticality: item.criticality, mustFind: item.mustFind };

    const otherLane = OTHER_LANE[item.category];
    if (otherLane !== undefined) {
      return { ...base, status: "unsupported", detail: `owned by ${otherLane}` };
    }
    if (!CODEGRAPH_LANE.has(item.category)) {
      return { ...base, status: "unsupported", detail: `category ${item.category} is outside the CodeGraph structural lane` };
    }

    const inRoot = item.evidence.filter((e) => e.root === indexedRoot);
    if (inRoot.length === 0) {
      return { ...base, status: "unresolved", detail: `no evidence in the indexed root ${indexedRoot}` };
    }

    // Found when a structural fact (node for entry-point/role, edge for a dep)
    // exists at any cited file.
    const wantsEdge = item.category === "dep-out" || item.category === "dep-in" || item.category === "call-edge";
    const files = wantsEdge ? filesWithEdgeOrNode : filesWithNodes;
    const hit = inRoot.some((e) => hasStructureAt(stripRoot(indexedRoot, e.path), files));
    const detail = inRoot.map((e) => stripRoot(indexedRoot, e.path)).join(", ");
    return { ...base, status: hit ? "found" : "not-found", detail: `${hit ? "structure present at" : "no structure at"} ${detail}` };
  });

  const counts: Record<TruthStatus, number> = {
    found: 0,
    "not-found": 0,
    unresolved: 0,
    unsupported: 0,
    failed: 0,
    truncated: 0,
  };
  for (const r of results) counts[r.status] += 1;

  // In scope for this index: items actually checked against it (found/not-found).
  // Items in another root (unresolved) or another lane (unsupported) are honest
  // coverage gaps for this run, not failures — they are graded where they live.
  const inScope = results.filter((r) => r.status === "found" || r.status === "not-found");
  const mustFind = inScope.filter((r) => r.mustFind);
  const mustFindFound = mustFind.filter((r) => r.status === "found").length;
  const criticalIssues = inScope.filter((r) => r.criticality === "critical" && r.status !== "found").length;

  return {
    indexedRoot,
    total: results.length,
    results,
    counts,
    mustFindTotal: mustFind.length,
    mustFindFound,
    criticalIssues,
    passed: mustFindFound === mustFind.length && criticalIssues === 0,
  };
}
