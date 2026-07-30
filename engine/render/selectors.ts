/**
 * What a section may ask the knowledge base for.
 *
 * A closed list rather than a query language. Every entry maps to one function
 * in `engine/kb/query.ts`, so a template can only ask questions someone has
 * decided how to answer honestly — and an unknown selector is refused at
 * prepare time with the vocabulary listed, never resolved to an empty slice
 * that reads as "the project has none".
 *
 * A selector may take one argument after a colon: a literal, or `$name` for a
 * value the caller supplied.
 */

import type { KnowledgeBase } from "../kb/query.js";
import type { StructuralKind } from "../structural/kinds.js";

export class SelectorError extends Error {
  constructor(name: string, detail: string) {
    super(`Unknown selector "${name}". ${detail}`);
    this.name = "SelectorError";
  }
}

type Resolver = (kb: KnowledgeBase, argument: string | null) => unknown;

const SELECTORS: Readonly<Record<string, Resolver>> = {
  "run-context": (kb) => kb.runContext(),
  features: (kb) => kb.features(),
  /**
   * Capabilities with the path of the document each links to.
   *
   * The link is computed here rather than left to a writer: a link a writer
   * adjusts is a link that does not resolve, and forty of them is forty
   * chances to get one wrong.
   */
  "capability-index": (kb) =>
    [...kb.features()]
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
      .map((feature) => ({
        id: feature.id,
        name: feature.name,
        document: `capabilities/${feature.name
          .toLowerCase()
          .replaceAll(/[^\w\s-]/g, "")
          .trim()
          .replaceAll(/\s+/g, "-")}.md`,
        parts: feature.rootNames,
        endpoints: feature.endpoints,
        tables: feature.tables,
        flowCount: feature.flowCount,
        partialFlowCount: feature.partialFlowCount,
        evidence: feature.signals,
      })),
  "feature-detail": (kb, id) => (id === null ? null : kb.featureDetail(id)),
  "feature-flows": (kb, id) => (id === null ? [] : kb.flowsForFeature(id)),
  "feature-rules": (kb, id) => (id === null ? [] : kb.rulesForFeature(id)),
  "feature-findings-for": (kb, id) =>
    id === null ? [] : kb.featureFindings().filter((finding) => finding.featureId === id),
  modules: (kb) => kb.modules(),
  components: (kb) => kb.components(),
  endpoints: (kb) => kb.endpoints(),
  screens: (kb) => kb.screens(),
  entities: (kb) => kb.entities(),
  "entity-model": (kb, name) => (name === null ? null : kb.entityModel(name)),
  "entity-models": (kb) =>
    kb.entities().map((entity) => kb.entityModel(entity.name, entity.rootName)),
  "value-sets": (kb) => kb.valueSets(),
  "business-rules": (kb) => kb.businessRules(),
  decisions: (kb) => kb.decisions(),
  "feature-decisions": (kb, id) => (id === null ? [] : kb.decisionsForFeature(id)),
  "feature-guards": (kb, id) => (id === null ? [] : kb.guardsForFeature(id)),
  "silent-files": (kb) => kb.silentFiles(),
  "unread-files": (kb) => kb.unreadFiles(),
  "feature-silent-files": (kb, id) => (id === null ? [] : kb.silentFilesForFeature(id)),
  "feature-unread-files": (kb, id) => (id === null ? [] : kb.unreadFilesForFeature(id)),
  "feature-permissions": (kb, id) => (id === null ? [] : kb.permissionsForFeature(id)),
  "feature-screens": (kb, id) => (id === null ? [] : kb.screensForFeature(id)),
  "feature-status-sets": (kb, id) => (id === null ? [] : kb.statusSetsForFeature(id)),
  "feature-scheduled": (kb, id) => (id === null ? [] : kb.automationForFeature(id).scheduled),
  "feature-notifications": (kb, id) =>
    id === null ? [] : kb.automationForFeature(id).notifications,
  "scheduled-tasks": (kb) => kb.scheduledTasks(),
  guards: (kb) => kb.guards(),
  "structural-findings": (kb, severity) => kb.structuralFindings(severity ?? undefined),
  "feature-findings": (kb, severity) => kb.featureFindings(severity ?? undefined),
  signals: (kb) => kb.signals(),
  "map-edges": (kb) => kb.mapEdges(),
  integrations: (kb) => kb.integrations(),
  "data-ownership": (kb) => kb.dataOwnership(),
  "data-access": (kb) => kb.dataAccess(),
  "auth-annotations": (kb) => kb.authAnnotations(),
  "outbound-calls": (kb) => kb.outboundCalls(),
  dependencies: (kb) => kb.dependencies(),
  reliability: (kb) => kb.reliability(),
  "test-presence": (kb) => kb.testPresence(),
  repositories: (kb) => kb.repositories(),
  "analysis-dimensions": (kb) => kb.analysisDimensions(),
  "flow-coverage": (kb) => kb.flowCoverage(),
  "feature-flow-coverage": (kb, id) => (id === null ? null : kb.flowCoverageForFeature(id)),
  "coverage-notes": (kb) => kb.coverageNotes(),
  "extraction-failures": (kb) => kb.extractionFailures(),
  evidence: (kb, kind) => kb.evidence(kind ?? undefined),
  coverage: (kb, kind) => (kind === null ? null : kb.coverageFor(kind as StructuralKind)),
};

export function selectorNames(): readonly string[] {
  return Object.keys(SELECTORS).sort();
}

/**
 * Resolves one `requires:` entry.
 *
 * A `$name` argument the caller did not supply is an error rather than a null
 * lookup: a module document rendered without a module is not an empty
 * document, it is a mistake.
 */
export function resolveSelector(
  kb: KnowledgeBase,
  selector: string,
  params: Readonly<Record<string, string>>,
): unknown {
  const [name, rawArgument] = splitSelector(selector);
  // Own properties only, or `toString` resolves to a function.
  if (!Object.hasOwn(SELECTORS, name)) {
    throw new SelectorError(selector, `Available: ${selectorNames().join(", ")}`);
  }
  const resolver = SELECTORS[name]!;

  let argument: string | null = rawArgument;
  if (rawArgument !== null && rawArgument.startsWith("$")) {
    const key = rawArgument.slice(1);
    const supplied = params[key];
    if (supplied === undefined) {
      throw new SelectorError(selector, `It needs --param ${key}=<value>.`);
    }
    argument = supplied;
  }

  return resolver(kb, argument);
}

function splitSelector(selector: string): [string, string | null] {
  const colon = selector.indexOf(":");
  return colon === -1
    ? [selector, null]
    : [selector.slice(0, colon), selector.slice(colon + 1)];
}

/** True when a selector's result carries nothing to show. */
export function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
