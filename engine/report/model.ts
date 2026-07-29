/**
 * The shape a report is assembled from, and the language it is rendered in.
 *
 * Deliberately a plain data structure with no rendering in it. HTML is one
 * renderer; DOCX and PDF are siblings of it, not rewrites — so nothing here
 * may assume a target format.
 */

import type { HealthSignal } from "../health/signals.js";
import type { FeatureFinding } from "../health/features.js";
import type { StructuralFinding } from "../health/structure.js";
import type { ProductModule, TechnicalComponent, DispositionCounts } from "../modules/form.js";

/**
 * Output language. Open on purpose: the set of languages a reader might want
 * is not ours to close, and an unknown one falls back to English rather than
 * emitting a half-translated report.
 */
export type OutputLanguage = "en" | "zh" | "es" | "ja" | (string & {});

export const DEFAULT_LANGUAGE: OutputLanguage = "en";

export interface ReportRootSummary {
  readonly name: string;
  readonly language: string | null;
  readonly fileCount: number;
  readonly analyzed: number;
  readonly excluded: number;
}

export interface ModuleEntryPoint {
  readonly method: string | null;
  readonly path: string;
  readonly rootName: string;
}

export interface ReportModule {
  readonly id: string;
  readonly name: string;
  readonly entryPoints: readonly string[];
  /** The entry points broken out, so a page can show what the feature exposes. */
  readonly routes: readonly ModuleEntryPoint[];
  readonly rootNames: readonly string[];
  readonly symbolCount: number;
  /** Data entities this feature's roots declare, by name. */
  readonly dataEntities: readonly string[];
  /** Destinations this feature's roots call outward, deduplicated. */
  readonly outboundTargets: readonly string[];
  /** Prose the developers already wrote, quoted rather than paraphrased. */
  readonly evidence: readonly string[];
}

/**
 * One edge of the project map.
 *
 * `kind` separates a call between our own roots from a call to something
 * outside, because a reader needs to see the boundary of the system before
 * anything inside it makes sense.
 */
export interface MapEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "internal" | "external" | "datastore";
  readonly detail: string | null;
}

export interface ReportComponent {
  readonly id: string;
  readonly name: string;
  readonly rootName: string;
  readonly signals: readonly string[];
  readonly memberCount: number;
}

/**
 * A product capability, as a reader would name it.
 *
 * Distinct from a module: a module is a unit of code, a feature is something
 * the product does. Leave spans three services and one of them also serves
 * Worklog, so the two groupings genuinely differ and collapsing them would
 * lose whichever the reader was after.
 */
export interface ReportFeature {
  readonly id: string;
  readonly name: string;
  readonly rootNames: readonly string[];
  /** What made this a feature: which kinds of evidence named it, and how much. */
  readonly signals: readonly string[];
  readonly endpoints: readonly ModuleEntryPoint[];
  readonly dataEntities: readonly string[];
  /** Tables the feature's handlers were observed to touch. */
  readonly tables: readonly string[];
  readonly flows: readonly ReportFlow[];
  /** Every flow the feature has, which may exceed the number detailed above. */
  readonly totalFlowCount: number;
  /** The feature at a glance: callers, endpoints, tables. */
  readonly overviewDiagram: string;
  /** How many of this feature's flows have at least one unestablished hop. */
  readonly partialFlowCount: number;
  /** What is worth a second look in this capability specifically. */
  readonly findings: readonly FeatureFinding[];
  /**
   * The rules this capability enforces, as the code states them.
   *
   * Only the notable ones — a rule two parts disagree about, one stated in a
   * number the project never names, or one written out in several places.
   * Publishing every comparison would bury these among array bounds.
   */
  readonly rules: readonly ReportRule[];
  /** How many conditions were observed in total, so the scale is visible. */
  readonly conditionCount: number;
}

export interface ReportFlowStep {
  readonly kind: string;
  readonly label: string;
  readonly rootName: string | null;
  readonly conditions: readonly string[];
  readonly unresolvedReason: string | null;
  /** True when the step stands in for others left out of the display. */
  readonly truncated: boolean;
  /** True when observed near the handler rather than in it. */
  readonly indirect: boolean;
  /** `root/path:line`, so a claim can be checked against the source. */
  readonly location: string | null;
}

export interface ReportFlow {
  readonly entryKey: string;
  readonly method: string | null;
  readonly path: string;
  readonly steps: readonly ReportFlowStep[];
  readonly diagram: string;
  readonly partial: boolean;
}

export interface ReportRule {
  /** The rule in words, with values named where the project names them. */
  readonly statement: string;
  /** The comparison as written, for a reader who wants the original. */
  readonly text: string;
  readonly service: string;
  readonly location: string;
  /** Why this rule is worth publishing. */
  readonly reason: "disagreed" | "unnamed-value" | "repeated";
}

export interface ReportScreen {
  readonly rootName: string;
  readonly path: string;
  /** False when the screen sits under a parent declared in another file. */
  readonly pathComplete: boolean;
}

export interface ReportIntegration {
  readonly from: string;
  readonly to: string;
  readonly calls: number;
}

export interface CoverageNote {
  readonly subject: string;
  readonly note: string;
}

/**
 * Everything a report can say, gathered once.
 *
 * `runId` is on the report itself so an overview and a module report generated
 * separately can be recognized as describing the same run — without it, two
 * reports could silently describe different analyses of the same project.
 */
export interface ReportModel {
  readonly runId: string;
  readonly generatedAt: string;
  readonly workspacePath: string;
  readonly projectName: string;
  readonly description: string | null;
  readonly language: OutputLanguage;
  readonly roots: readonly ReportRootSummary[];
  readonly modules: readonly ReportModule[];
  readonly features: readonly ReportFeature[];
  readonly components: readonly ReportComponent[];
  readonly integrations: readonly ReportIntegration[];
  /** The system's shape: our roots, what they call, and what is outside. */
  readonly map: readonly MapEdge[];
  /** Findings about the architecture rather than about one capability. */
  readonly structuralFindings: readonly StructuralFinding[];
  /** The same shape as a diagram, rendered once so every format shares it. */
  readonly mapDiagram: string;
  /** Endpoints that belong to no detected feature, with the count kept honest. */
  readonly unassignedEndpointCount: number;
  /**
   * The screens a browser application declares.
   *
   * Separate from endpoints because they are: an indexer reports both as
   * routes, and listing them together turns a React component into an API.
   */
  readonly screens: readonly ReportScreen[];
  /** Data entities recovered from schemas and migrations. */
  readonly dataEntities: readonly string[];
  readonly signals: readonly HealthSignal[];
  /** Only the signals worth a reader's attention — minor noise is filtered out. */
  readonly attentionSignals: readonly HealthSignal[];
  readonly dispositions: DispositionCounts;
  /**
   * What this report cannot tell you, in words.
   *
   * Carried into the report rather than left in the knowledge base: a reader
   * deciding based on this needs to know what was not measured, and a coverage
   * gap only visible to whoever queries the database is a gap nobody sees.
   */
  readonly coverageNotes: readonly CoverageNote[];
}

export interface AssembleReportInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly workspacePath: string;
  readonly projectName: string;
  readonly description: string | null;
  readonly language: OutputLanguage;
  readonly roots: readonly ReportRootSummary[];
  readonly modules: readonly ProductModule[];
  readonly features: readonly ReportFeature[];
  readonly mapDiagram: string;
  readonly structuralFindings: readonly StructuralFinding[];
  readonly unassignedEndpointCount: number;
  readonly screens: readonly ReportScreen[];
  readonly components: readonly TechnicalComponent[];
  readonly integrations: readonly ReportIntegration[];
  readonly map: readonly MapEdge[];
  readonly dataEntities: readonly string[];
  readonly signals: readonly HealthSignal[];
  readonly dispositions: DispositionCounts;
  readonly evidenceByModule: ReadonlyMap<string, readonly string[]>;
  readonly routesByModule: ReadonlyMap<string, readonly ModuleEntryPoint[]>;
  readonly dataByModule: ReadonlyMap<string, readonly string[]>;
  readonly outboundByModule: ReadonlyMap<string, readonly string[]>;
  readonly coverageNotes: readonly CoverageNote[];
}

export function assembleReport(input: AssembleReportInput): ReportModel {
  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    workspacePath: input.workspacePath,
    projectName: input.projectName,
    description: input.description,
    language: input.language,
    roots: input.roots,
    modules: input.modules.map((module) => ({
      id: module.id,
      name: module.name,
      entryPoints: module.entryKeys,
      routes: input.routesByModule.get(module.id) ?? [],
      rootNames: module.rootNames,
      symbolCount: module.symbolIds.length,
      dataEntities: input.dataByModule.get(module.id) ?? [],
      outboundTargets: input.outboundByModule.get(module.id) ?? [],
      evidence: input.evidenceByModule.get(module.id) ?? [],
    })),
    components: input.components.map((component) => ({
      id: component.id,
      name: component.name,
      rootName: component.rootName,
      signals: component.signals,
      memberCount: component.memberPaths.length,
    })),
    features: input.features,
    integrations: input.integrations,
    map: input.map,
    mapDiagram: input.mapDiagram,
    structuralFindings: input.structuralFindings,
    unassignedEndpointCount: input.unassignedEndpointCount,
    screens: input.screens,
    dataEntities: input.dataEntities,
    signals: input.signals,
    // Minor observations are noise in a summary; a list nobody finishes
    // reading is a list nobody acts on.
    attentionSignals: input.signals.filter((signal) => signal.severity !== "info"),
    dispositions: input.dispositions,
    coverageNotes: input.coverageNotes,
  };
}
