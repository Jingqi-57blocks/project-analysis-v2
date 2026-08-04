/**
 * What each root contains, read once.
 *
 * This is the reading half of the pipeline: providers run, their contributions
 * are merged into one model per root, and nothing here concludes anything. A
 * route is a route; whether it belongs to a feature is decided later, over the
 * whole workspace, because a capability that spans three services cannot be
 * seen from inside any one of them.
 *
 * The data-model readers join the same merge. They used to run alongside it
 * and have their output concatenated, which meant a table declared in a
 * migration and mapped by a struct was two tables.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assemble, extractAll, type AssembledModel } from "../structural/assemble.js";
import { consolidateRoutes } from "../structural/routededupe.js";
import type {
  ExtractionFailure,
  StructuralContribution,
  StructuralProvider,
} from "../structural/provider.js";
import { assembleEvidence, collectAll, type AssembledEvidenceSet } from "../semantic/assemble.js";
import type { SemanticCollector } from "../semantic/types.js";
import { toStructuralContribution, toStructuralCapabilities } from "../datamodel/persist.js";
import type { DataModelProvider } from "../datamodel/types.js";
import { valueSetsIn, type ValueSet } from "../semantics/enums.js";
import type { ProviderCapabilities } from "../structural/provider.js";
import type { RootSummaryFact } from "./facts.js";

/** What one root contributed, with everything needed to persist it. */
export interface RootFacts {
  readonly rootName: string;
  /** Merged across every provider, with attributions and retained conflicts. */
  readonly model: AssembledModel;
  /** Per provider, kept so capability accounting can be written per source. */
  readonly contributions: readonly {
    readonly contribution: StructuralContribution;
    readonly capabilities: ProviderCapabilities | null;
  }[];
  readonly evidence: AssembledEvidenceSet;
  readonly valueSets: readonly ValueSet[];
  /** Files whose vocabulary could not be read, so the absence is accounted for. */
  readonly vocabularyFailures: readonly ExtractionFailure[];
  readonly summary: RootSummaryFact;
  readonly analyzedFiles: readonly string[];
  /**
   * Files inventory classified as generated.
   *
   * Their example payloads and mock URLs are not calls the system makes, and
   * the provider never has to guess because inventory already decided.
   */
  readonly generatedFiles: ReadonlySet<string>;
}

export interface ExtractRootInput {
  readonly name: string;
  readonly path: string;
  readonly analyzedFiles: readonly string[];
  readonly generatedFiles: ReadonlySet<string>;
  readonly excludedCount: number;
  readonly structuralProviders: readonly StructuralProvider[];
  readonly dataProviders: readonly DataModelProvider[];
  readonly collectors: readonly SemanticCollector[];
}

/**
 * Runs every reader over one root and merges what they found.
 *
 * Consolidation folds one provider's prefix-less route inferences into
 * another's full paths: they have different record keys, so the merge contract
 * alone cannot unify them, and without this a project appears to serve both
 * `/leaves` and `/v2/leaves`.
 */
export function extractRoot(input: ExtractRootInput): RootFacts {
  const rootInput = {
    name: input.name,
    path: input.path,
    analyzedFiles: input.analyzedFiles,
  };

  const structural = extractAll(input.structuralProviders, rootInput);
  const contributions: RootFacts["contributions"] = [
    ...structural.map((contribution, index) => ({
      contribution,
      capabilities: input.structuralProviders[index]?.structuralCapabilities() ?? null,
    })),
    ...input.dataProviders.map((provider) => ({
      contribution: toStructuralContribution(provider.extract(rootInput)),
      capabilities: toStructuralCapabilities(provider.capabilities()),
    })),
  ];

  const model = consolidateRoutes(
    assemble(
      input.name,
      contributions.map((entry) => entry.contribution),
    ),
  );

  const vocabulary = readValueSets(input.name, input.path, input.analyzedFiles);

  return {
    rootName: input.name,
    model,
    contributions,
    evidence: assembleEvidence(input.name, collectAll(input.collectors, rootInput)),
    valueSets: vocabulary.sets,
    vocabularyFailures: vocabulary.failures,
    summary: {
      name: input.name,
      language: null,
      analyzed: input.analyzedFiles.length,
      excluded: input.excludedCount,
    },
    analyzedFiles: input.analyzedFiles,
    generatedFiles: input.generatedFiles,
  };
}

/**
 * The names a project gives its own values.
 *
 * Read here rather than by a provider because a value set is not a structural
 * fact about one file — it is the vocabulary a rule elsewhere is stated in,
 * and matching the two is a workspace-level question.
 */
function readValueSets(
  rootName: string,
  rootPath: string,
  analyzedFiles: readonly string[],
): { sets: readonly ValueSet[]; failures: readonly ExtractionFailure[] } {
  const sets: ValueSet[] = [];
  const failures: ExtractionFailure[] = [];
  for (const relPath of analyzedFiles) {
    try {
      sets.push(...valueSetsIn(rootName, relPath, readFileSync(join(rootPath, relPath), "utf8")));
    } catch (error) {
      // Recorded, not swallowed: a run where every read threw would otherwise
      // report a project that names none of its own values.
      failures.push({
        scope: relPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { sets, failures };
}
