/**
 * Turns detected features and assembled flows into what a report shows.
 *
 * Kept apart from both the detector and the renderers: the detector answers
 * "what are the capabilities", the renderers answer "how does this look in
 * HTML", and neither should have to know the other's shape.
 */

import type { DomainFeature } from "../modules/features.js";
import type { FeatureFlow, FlowStep } from "../flows/types.js";
import { featureOverviewMermaid, flowToMermaid, escapeLabel } from "../flows/mermaid.js";
import type { MapEdge, ReportFeature, ReportFlow, ReportFlowStep } from "./model.js";

function locationOf(step: FlowStep): string | null {
  if (step.provenance === null) return null;
  const { rootName, relPath, startLine } = step.provenance.source;
  return `${rootName}/${relPath}:${startLine}`;
}

function toReportStep(step: FlowStep): ReportFlowStep {
  return {
    kind: step.kind,
    label: step.label,
    rootName: step.rootName,
    conditions: step.conditions,
    unresolvedReason: step.unresolvedReason,
    location: locationOf(step),
  };
}

function toReportFlow(flow: FeatureFlow): ReportFlow {
  return {
    entryKey: flow.entryKey,
    method: flow.method,
    path: flow.path,
    steps: flow.steps.map(toReportStep),
    diagram: flowToMermaid(flow),
    partial: flow.partial,
  };
}

export interface FeatureViewLimits {
  /** Flows detailed per feature. The rest are still counted and listed. */
  readonly maxFlows: number;
}

export const DEFAULT_FEATURE_LIMITS: FeatureViewLimits = { maxFlows: 25 };

/**
 * Builds the report's view of each feature.
 *
 * Flows with every hop established come first: a reader comparing two features
 * should meet the complete pictures before the partial ones, and a partial
 * flow is still shown rather than hidden.
 */
export function buildReportFeatures(
  features: readonly DomainFeature[],
  flows: readonly FeatureFlow[],
  limits: FeatureViewLimits = DEFAULT_FEATURE_LIMITS,
): readonly ReportFeature[] {
  const byFeature = new Map<string, FeatureFlow[]>();
  for (const flow of flows) {
    const existing = byFeature.get(flow.featureId) ?? [];
    existing.push(flow);
    byFeature.set(flow.featureId, existing);
  }

  return features.map((feature): ReportFeature => {
    const own = (byFeature.get(feature.id) ?? []).slice().sort((a, b) => {
      if (a.partial !== b.partial) return a.partial ? 1 : -1;
      return a.entryKey.localeCompare(b.entryKey);
    });

    const tables = new Set<string>();
    for (const flow of own) {
      for (const step of flow.steps) {
        if (step.kind === "data-access" && step.unresolvedReason === null) tables.add(step.label);
      }
    }

    return {
      id: feature.id,
      name: feature.name,
      rootNames: feature.rootNames,
      signals: feature.signals,
      endpoints: feature.routes.map((route) => ({
        method: route.method,
        path: route.path,
        rootName: route.rootName,
      })),
      dataEntities: feature.entities,
      tables: [...tables].sort(),
      flows: own.slice(0, limits.maxFlows).map(toReportFlow),
      totalFlowCount: own.length,
      overviewDiagram: featureOverviewMermaid(feature.name, own),
      partialFlowCount: own.filter((flow) => flow.partial).length,
    };
  });
}

/**
 * The project map as a diagram.
 *
 * The edge kinds carry different meanings — one of our services calling
 * another is not the same as either of them calling Stripe — so they are drawn
 * with different shapes rather than left for a reader to infer from names.
 */
export function mapToMermaid(edges: readonly MapEdge[]): string {
  if (edges.length === 0) return "flowchart LR\n  none[\"no connections were observed\"]";

  const lines = ["flowchart LR"];
  const declared = new Set<string>();
  const seenEdges = new Set<string>();

  const declare = (name: string, kind: MapEdge["kind"], side: "from" | "to"): string => {
    const id = `n_${name.replaceAll(/[^\w]/g, "_")}`;
    if (declared.has(id)) return id;
    declared.add(id);

    const label = escapeLabel(name);
    if (kind === "datastore" && side === "to") lines.push(`  ${id}[("${label}")]`);
    else if (kind === "external" && side === "to") lines.push(`  ${id}(["${label}"])`);
    else lines.push(`  ${id}["${label}"]`);
    return id;
  };

  for (const edge of edges) {
    const from = declare(edge.from, edge.kind, "from");
    const to = declare(edge.to, edge.kind, "to");
    const label = edge.detail === null ? "" : `|"${escapeLabel(edge.detail)}"|`;
    const line = `  ${from} -->${label} ${to}`;
    if (seenEdges.has(line)) continue;
    seenEdges.add(line);
    lines.push(line);
  }

  return lines.join("\n");
}
