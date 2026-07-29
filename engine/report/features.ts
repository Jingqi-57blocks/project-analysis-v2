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
import type { MapEdge, ReportFeature, ReportFlow, ReportFlowStep, ReportRule } from "./model.js";
import { computeFeatureFindings, findingsFor } from "../health/features.js";
import { computeLogicFindings, findDivergence } from "../health/logic.js";
import { isUnexplained, type BusinessRule } from "../semantics/rules.js";
import type { DiscardedErrorRecord } from "../structural/rules.js";

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
    truncated: step.truncated === true,
    indirect: step.indirect === true,
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
  /** Notable rules published per feature. */
  readonly maxRules: number;
}

export const DEFAULT_FEATURE_LIMITS: FeatureViewLimits = { maxFlows: 25, maxRules: 20 };

/**
 * The behavioural evidence a capability owns, joined by the files it owns.
 *
 * Passed in rather than recomputed here: the rules are stated once for the
 * whole workspace, because a disagreement between two parts is only visible
 * from outside both.
 */
export interface FeatureBehaviour {
  readonly rules: readonly BusinessRule[];
  readonly discarded: readonly DiscardedErrorRecord[];
  /** Feature id → the files it owns, qualified as `root/relPath`. */
  readonly filesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The field a rule is about, as one word — the same key the detectors use. */
function fieldWord(subject: string): string {
  const last = subject.split(".").pop() ?? subject;
  const words = last
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  return words[words.length - 1] ?? last.toLowerCase();
}

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
  behaviour: FeatureBehaviour = { rules: [], discarded: [], filesByFeature: new Map() },
  limits: FeatureViewLimits = DEFAULT_FEATURE_LIMITS,
): readonly ReportFeature[] {
  // An endpoint belongs to one feature. Listing it under every feature whose
  // term appears anywhere in its path puts cancel-a-leave-application under
  // "Application", a workflow it has nothing to do with, and dilutes both.
  const owner = new Map<string, string>();
  for (const flow of flows) owner.set(flow.entryKey, flow.featureId);
  const byFeature = new Map<string, FeatureFlow[]>();
  for (const flow of flows) {
    const existing = byFeature.get(flow.featureId) ?? [];
    existing.push(flow);
    byFeature.set(flow.featureId, existing);
  }

  const built = features.map((feature): ReportFeature => {
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
      endpoints: feature.routes
        .filter((route) => {
          const key = `${route.rootName}:${route.method ?? "ANY"} ${route.path}`;
          const owned = owner.get(key);
          // An endpoint no flow claimed keeps its term match: it is still
          // this feature's best home, and dropping it would lose it entirely.
          return owned === undefined || owned === feature.id;
        })
        .map((route) => ({
          method: route.method,
          path: route.path,
          rootName: route.rootName,
        })),
      dataEntities: feature.entities,
      tables: [...tables].sort(),
      flows: own.slice(0, limits.maxFlows).map(toReportFlow),
      totalFlowCount: own.length,
      rules: [],
      conditionCount: 0,
      overviewDiagram: featureOverviewMermaid(feature.name, own),
      partialFlowCount: own.filter((flow) => flow.partial).length,
      findings: [],
    };
  });

  // Computed against the assembled view, then attached, because a finding is
  // about what the report says a feature is — not about the raw records.
  const findings = computeFeatureFindings(built);
  const divergentSubjects = new Set(
    findDivergence(behaviour.rules).flatMap((entry) =>
      entry.variants.map((rule) => `${rule.rootName}|${rule.relPath}|${rule.startLine}`),
    ),
  );

  const repetitionCounts = new Map<string, number>();
  for (const rule of behaviour.rules) {
    if (typeof rule.literal !== "number") continue;
    const key = `${fieldWord(rule.subject)}|${rule.operator}|${rule.literal}`;
    repetitionCounts.set(key, (repetitionCounts.get(key) ?? 0) + 1);
  }

  return built.map((feature) => {
    const owned = behaviour.filesByFeature.get(feature.id) ?? new Set<string>();
    const ownRules = behaviour.rules.filter((rule) =>
      owned.has(`${rule.rootName}/${rule.relPath}`),
    );
    const ownDiscarded = behaviour.discarded.filter((record) =>
      owned.has(`${record.rootName}/${record.source.relPath}`),
    );

    const notable = ownRules
      .map((rule): ReportRule | null => {
        const site = `${rule.rootName}|${rule.relPath}|${rule.startLine}`;
        const key = `${fieldWord(rule.subject)}|${rule.operator}|${rule.literal}`;
        const reason: ReportRule["reason"] | null = divergentSubjects.has(site)
          ? "disagreed"
          : (repetitionCounts.get(key) ?? 0) >= 3
            ? "repeated"
            : isUnexplained(rule) === false
              ? null
              : typeof rule.literal === "number"
                ? "unnamed-value"
                : null;
        if (reason === null) return null;

        return {
          statement: rule.statement,
          text: rule.text,
          service: rule.rootName,
          location: `${rule.rootName}/${rule.relPath}:${rule.startLine}`,
          reason,
        };
      })
      .filter((rule): rule is ReportRule => rule !== null);

    // Disagreements first: a rule two parts apply differently is the one a
    // reader most needs, and a long list of bare numbers would bury it.
    const order: Record<ReportRule["reason"], number> = {
      disagreed: 0,
      repeated: 1,
      "unnamed-value": 2,
    };
    notable.sort((a, b) => order[a.reason] - order[b.reason] || a.statement.localeCompare(b.statement));

    const withBehaviour: ReportFeature = {
      ...feature,
      findings: findingsFor(findings, feature.id),
      rules: notable.slice(0, limits.maxRules),
      conditionCount: ownRules.length,
    };

    return {
      ...withBehaviour,
      findings: [
        ...withBehaviour.findings,
        ...computeLogicFindings({
          featureId: feature.id,
          featureName: feature.name,
          rules: ownRules,
          discarded: ownDiscarded,
          allRules: behaviour.rules,
        }),
      ],
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
