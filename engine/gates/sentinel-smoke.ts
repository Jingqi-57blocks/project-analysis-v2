/**
 * The no-dedicated-reader structural smoke gate (PI-66).
 *
 * Proves that a root no route reader covers — angels-pizza's Vue frontends —
 * still yields useful structure through the generic CodeGraph path, rather than
 * an all-unknown or a wrong "no interface" conclusion. Grades the angels-pizza
 * sentinels: every positive must be found via the generic path, and every
 * clean-absence must be honored (no server routes invented for a client SPA).
 * The gate passes only when real structure was produced.
 */

import type { ImportedEdge } from "../providers/codegraph/importedges.js";
import type { ImportedNode } from "../providers/codegraph/importnodes.js";
import type { SentinelItem } from "../contracts/truth/sentinel.js";

export type SentinelStatus = "found" | "not-found" | "absent" | "present" | "unresolved";

export interface SentinelResult {
  readonly id: string;
  readonly kind: SentinelItem["kind"];
  readonly category: string;
  readonly status: SentinelStatus;
  readonly detail: string;
}

export interface SmokeGateReport {
  readonly indexedRoot: string;
  readonly total: number;
  readonly results: readonly SentinelResult[];
  readonly usefulStructureNodes: number;
  readonly positivesFound: number;
  readonly positivesTotal: number;
  readonly cleanAbsencesHonored: number;
  readonly cleanAbsencesTotal: number;
  readonly passed: boolean;
}

function hasStructureAt(rel: string, files: ReadonlySet<string>): boolean {
  if (files.has(rel)) return true;
  const prefix = rel.endsWith("/") ? rel : `${rel}/`;
  for (const file of files) if (file.startsWith(prefix)) return true;
  return false;
}

export function gradeSentinels(
  items: readonly SentinelItem[],
  nodes: readonly ImportedNode[],
  edges: readonly ImportedEdge[],
  indexedRoot: string,
): SmokeGateReport {
  const files = new Set<string>([...nodes.map((n) => n.filePath), ...edges.map((e) => e.filePath)]);
  // A client SPA should have no server-route structure; the generic path must not invent one.
  const hasServerRoute = nodes.some((n) => n.structuralKind === "route");

  const results: SentinelResult[] = items.map((item) => {
    const head = { id: item.id, kind: item.kind, category: item.category };
    if (item.root !== indexedRoot) {
      return { ...head, status: "unresolved", detail: `sentinel root ${item.root} is not the indexed root ${indexedRoot}` };
    }
    if (item.kind === "clean-absence") {
      return hasServerRoute
        ? { ...head, status: "present", detail: "server-route structure present where absence was expected" }
        : { ...head, status: "absent", detail: "confirmed: no server routes invented for the SPA" };
    }
    const present = item.evidence.some((e) => hasStructureAt(e.path, files));
    const cited = item.evidence.map((e) => e.path).join(", ");
    return {
      ...head,
      status: present ? "found" : "not-found",
      detail: `${present ? "structure present at" : "no structure at"} ${cited}`,
    };
  });

  const inRoot = results.filter((r) => r.status !== "unresolved");
  const positives = inRoot.filter((r) => r.kind === "positive");
  const cleans = inRoot.filter((r) => r.kind === "clean-absence");
  const positivesFound = positives.filter((r) => r.status === "found").length;
  const cleanHonored = cleans.filter((r) => r.status === "absent").length;

  return {
    indexedRoot,
    total: results.length,
    results,
    usefulStructureNodes: nodes.length,
    positivesFound,
    positivesTotal: positives.length,
    cleanAbsencesHonored: cleanHonored,
    cleanAbsencesTotal: cleans.length,
    passed:
      nodes.length > 0 &&
      positivesFound === positives.length &&
      cleanHonored === cleans.length,
  };
}
