/**
 * The shape a report is assembled from, and the language it is rendered in.
 *
 * Deliberately a plain data structure with no rendering in it. HTML is one
 * renderer; DOCX and PDF are siblings of it, not rewrites — so nothing here
 * may assume a target format.
 */

import type { HealthSignal } from "../health/signals.js";
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

export interface ReportModule {
  readonly id: string;
  readonly name: string;
  readonly entryPoints: readonly string[];
  readonly rootNames: readonly string[];
  readonly symbolCount: number;
  /** Prose the developers already wrote, quoted rather than paraphrased. */
  readonly evidence: readonly string[];
}

export interface ReportComponent {
  readonly id: string;
  readonly name: string;
  readonly rootName: string;
  readonly signals: readonly string[];
  readonly memberCount: number;
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
  readonly components: readonly ReportComponent[];
  readonly integrations: readonly ReportIntegration[];
  readonly signals: readonly HealthSignal[];
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
  readonly components: readonly TechnicalComponent[];
  readonly integrations: readonly ReportIntegration[];
  readonly signals: readonly HealthSignal[];
  readonly dispositions: DispositionCounts;
  readonly evidenceByModule: ReadonlyMap<string, readonly string[]>;
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
      rootNames: module.rootNames,
      symbolCount: module.symbolIds.length,
      evidence: input.evidenceByModule.get(module.id) ?? [],
    })),
    components: input.components.map((component) => ({
      id: component.id,
      name: component.name,
      rootName: component.rootName,
      signals: component.signals,
      memberCount: component.memberPaths.length,
    })),
    integrations: input.integrations,
    signals: input.signals,
    dispositions: input.dispositions,
    coverageNotes: input.coverageNotes,
  };
}
