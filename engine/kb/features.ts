/**
 * Capabilities, joined to everything observed about them.
 *
 * The detector answers "what are the capabilities" and the flow assembler
 * answers "what happens when one is used"; this is where those meet the rules
 * a capability enforces and the findings about it. Kept apart from both,
 * because a join is not a detection and mixing them would make either one hard
 * to test alone.
 *
 * Nothing here words anything. A feature comes out as what was observed of it
 * — endpoints, tables, flows, rules, findings — and what that means for a
 * reader is a template's business.
 */

import type { DomainFeature } from "../modules/features.js";
import type { FeatureFlow } from "../flows/types.js";
import { featureOverviewMermaid, flowToMermaid } from "../flows/mermaid.js";
import { computeFeatureFindings, findingsFor } from "../health/features.js";
import { computeLogicFindings, findDivergence } from "../health/logic.js";
import { isUnexplained, type BusinessRule } from "../semantics/rules.js";
import type { DiscardedErrorRecord } from "../structural/rules.js";
import type { FeatureFact, FeatureFindingFact, FeatureFlowFact } from "./facts.js";

/** How much of a capability is published in detail. The rest is still counted. */
export interface FeatureLimits {
  readonly maxRules: number;
}

export const DEFAULT_FEATURE_LIMITS: FeatureLimits = { maxRules: 20 };

/**
 * The behavioural evidence a capability owns, joined by the files it owns.
 *
 * Stated once for the whole workspace rather than per feature: a disagreement
 * between two parts is only visible from outside both.
 */
export interface FeatureBehaviour {
  readonly rules: readonly BusinessRule[];
  readonly discarded: readonly DiscardedErrorRecord[];
  /** Feature id → the files it owns, qualified as `root/relPath`. */
  readonly filesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface FeatureFacts {
  readonly features: readonly FeatureFact[];
  readonly flows: readonly FeatureFlowFact[];
  readonly findings: readonly FeatureFindingFact[];
  /** Feature id → the rules worth publishing for it, most important first. */
  readonly rulesByFeature: ReadonlyMap<string, readonly BusinessRule[]>;
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
 * Whether a rule is worth publishing, and why.
 *
 * Every comparison in a codebase is a condition; only some of them are rules a
 * reader needs. A rule two parts apply differently, one stated in a number the
 * project never names, or one written out in several places — those are worth
 * a reader's attention. Publishing all of them would bury these among array
 * bounds and retry counts.
 */
function ruleReason(
  rule: BusinessRule,
  divergentSites: ReadonlySet<string>,
  repetitionCounts: ReadonlyMap<string, number>,
): "disagreed" | "repeated" | "unnamed-value" | null {
  const site = `${rule.rootName}|${rule.relPath}|${rule.startLine}`;
  if (divergentSites.has(site)) return "disagreed";

  const key = `${fieldWord(rule.subject)}|${rule.operator}|${rule.literal}`;
  if ((repetitionCounts.get(key) ?? 0) >= 3) return "repeated";

  if (!isUnexplained(rule)) return null;
  return typeof rule.literal === "number" ? "unnamed-value" : null;
}

const REASON_ORDER: Record<"disagreed" | "repeated" | "unnamed-value", number> = {
  disagreed: 0,
  repeated: 1,
  "unnamed-value": 2,
};

/**
 * Joins detected capabilities to their flows, rules and findings.
 *
 * An endpoint belongs to one feature. Listing it under every feature whose
 * term appears anywhere in its path puts cancel-a-leave-application under
 * "Application", a workflow it has nothing to do with, and dilutes both.
 */
export function buildFeatureFacts(
  features: readonly DomainFeature[],
  flows: readonly FeatureFlow[],
  behaviour: FeatureBehaviour = { rules: [], discarded: [], filesByFeature: new Map() },
  limits: FeatureLimits = DEFAULT_FEATURE_LIMITS,
): FeatureFacts {
  const owner = new Map<string, string>();
  for (const flow of flows) owner.set(flow.entryKey, flow.featureId);

  const byFeature = new Map<string, FeatureFlow[]>();
  for (const flow of flows) {
    const existing = byFeature.get(flow.featureId) ?? [];
    existing.push(flow);
    byFeature.set(flow.featureId, existing);
  }

  const flowFacts: FeatureFlowFact[] = [];
  const built = features.map((feature): FeatureFact => {
    // Flows with every hop established come first: a reader comparing two
    // capabilities should meet the complete pictures before the partial ones.
    const own = (byFeature.get(feature.id) ?? []).slice().sort((a, b) => {
      if (a.partial !== b.partial) return a.partial ? 1 : -1;
      return a.entryKey.localeCompare(b.entryKey);
    });

    const tables = new Set<string>();
    for (const flow of own) {
      for (const step of flow.steps) {
        if (step.kind === "data-access" && step.unresolvedReason === null) tables.add(step.label);
      }
      flowFacts.push({ ...flow, diagram: flowToMermaid(flow) });
    }

    return {
      id: feature.id,
      name: feature.name,
      term: feature.term,
      weight: feature.weight,
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
        .map((route) => ({ method: route.method, path: route.path, rootName: route.rootName })),
      dataEntities: feature.entities,
      tables: [...tables].sort(),
      filePaths: feature.filePaths,
      flowCount: own.length,
      partialFlowCount: own.filter((flow) => flow.partial).length,
      conditionCount: 0,
      overviewDiagram: featureOverviewMermaid(feature.name, own),
    };
  });

  // Computed against the assembled view, then attached, because a finding is
  // about what the analysis concluded a feature is — not about raw records.
  const flowsById = new Map<string, FeatureFlowFact[]>();
  for (const flow of flowFacts) {
    flowsById.set(flow.featureId, [...(flowsById.get(flow.featureId) ?? []), flow]);
  }
  const reviewed = built.map((feature) => ({
    id: feature.id,
    name: feature.name,
    tables: feature.tables,
    flows: flowsById.get(feature.id) ?? [],
  }));
  const findings = computeFeatureFindings(reviewed);

  const divergentSites = new Set(
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

  const rulesByFeature = new Map<string, readonly BusinessRule[]>();
  const allFindings: FeatureFindingFact[] = [];

  const withRules = built.map((feature): FeatureFact => {
    const owned = behaviour.filesByFeature.get(feature.id) ?? new Set<string>();
    const ownRules = behaviour.rules.filter((rule) =>
      owned.has(`${rule.rootName}/${rule.relPath}`),
    );
    const ownDiscarded = behaviour.discarded.filter((record) =>
      owned.has(`${record.rootName}/${record.source.relPath}`),
    );

    const notable = ownRules
      .map((rule) => ({ rule, reason: ruleReason(rule, divergentSites, repetitionCounts) }))
      .filter((entry): entry is { rule: BusinessRule; reason: keyof typeof REASON_ORDER } =>
        entry.reason !== null,
      )
      // Disagreements first: a rule two parts apply differently is the one a
      // reader most needs, and a long list of bare numbers would bury it.
      .sort(
        (a, b) =>
          REASON_ORDER[a.reason] - REASON_ORDER[b.reason] ||
          a.rule.statement.localeCompare(b.rule.statement),
      )
      .slice(0, limits.maxRules)
      .map((entry) => entry.rule);

    rulesByFeature.set(feature.id, notable);
    allFindings.push(
      ...findingsFor(findings, feature.id),
      ...computeLogicFindings({
        featureId: feature.id,
        featureName: feature.name,
        rules: ownRules,
        discarded: ownDiscarded,
        allRules: behaviour.rules,
      }),
    );

    return { ...feature, conditionCount: ownRules.length };
  });

  return { features: withRules, flows: flowFacts, findings: allFindings, rulesByFeature };
}
