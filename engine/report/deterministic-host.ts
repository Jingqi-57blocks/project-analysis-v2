/**
 * The deterministic Host Agent (PI-21/22/23): a model-free host that satisfies the
 * execution seam `executeAuthoredTasks` drives, so the engine's Host Agent boundary
 * stays exactly as it is under a real LLM host.
 *
 * It calls no model. An authored task is accepted (and its block validates) when
 * there is a legitimate basis for the prose the LLM will later author: the task's
 * section resolves at least one cited fact, OR the section carries an honest
 * not-applicable / unknown applicability decision the authored block will disclose.
 * A task with neither is left a marked gap — a required authored block with no
 * grounding is never silently passed. The result is a REAL `validatedTaskIds` set,
 * not the vacuous all-pass a placeholder host would give.
 *
 * The prose itself is deferred: the validated artifact is a reference to the
 * deterministic fact digest, and the audience-specific text is the LLM authoring
 * phase's to write. Deterministic over the frozen KB and the plan.
 */

import { SECTION_CATALOG, type SectionDefinition } from "../contracts/report/catalog.js";
import type { AttemptReceipt, AuthoredBlockTask, HostAgent } from "../contracts/report/pipeline.js";
import type { SectionApplicabilityDecision } from "./applicability.js";
import type { DecisionIndex } from "./deterministic-content.js";
import { type SliceReaders, resolveSliceFacts } from "./slice-resolve.js";

export interface DeterministicHostOptions {
  readonly readers: SliceReaders;
  readonly decisions: DecisionIndex;
  /** Defaults to the shared section catalog. */
  readonly catalog?: readonly SectionDefinition[];
}

/** The section that owns a block id — the grounding an authored block is judged against. */
function indexSectionByBlock(catalog: readonly SectionDefinition[]): ReadonlyMap<string, SectionDefinition> {
  const index = new Map<string, SectionDefinition>();
  for (const section of catalog) {
    for (const block of section.blocks) index.set(block.id, section);
  }
  return index;
}

function legitimateDisclosure(decision: SectionApplicabilityDecision | undefined): boolean {
  return decision !== undefined && (decision.applicability === "not-applicable" || decision.applicability === "unknown");
}

/**
 * Build the deterministic host. Each authored task is validated iff its section is
 * grounded (resolves ≥1 cited fact) or carries an honest not-applicable / unknown
 * decision; otherwise the attempt is rejected and the block is left a marked gap.
 */
export function deterministicHost(options: DeterministicHostOptions): HostAgent {
  const catalog = options.catalog ?? SECTION_CATALOG;
  const sectionByBlock = indexSectionByBlock(catalog);

  return {
    execute(task: AuthoredBlockTask): Omit<AttemptReceipt, "attempt" | "taskId"> {
      const base = { executorKind: task.identity.executorKind, modelId: task.identity.modelId };
      const section = sectionByBlock.get(task.blockId);
      if (section === undefined) {
        return { ...base, outcome: "failed", artifactRef: null, validationOk: false, detail: `no catalog section for block ${task.blockId}` };
      }

      const sectionFacts = resolveSliceFacts(options.readers, task.factSlice.scope, section.inputFactKinds);
      const decision = options.decisions.get(task.documentId)?.get(section.id);

      if (sectionFacts.length >= 1) {
        return {
          ...base,
          outcome: "accepted",
          artifactRef: `fact-digest://${task.taskId}`,
          validationOk: true,
          detail: `grounded by ${sectionFacts.length} cited fact(s) in ${section.id}; prose deferred to the LLM host`,
        };
      }
      if (legitimateDisclosure(decision)) {
        return {
          ...base,
          outcome: "accepted",
          artifactRef: `fact-digest://${task.taskId}`,
          validationOk: true,
          detail: `structured ${decision!.applicability} disclosure for ${section.id}; prose deferred to the LLM host`,
        };
      }
      return {
        ...base,
        outcome: "rejected",
        artifactRef: null,
        validationOk: false,
        detail: `no cited facts and no not-applicable/unknown decision for ${section.id} — left a marked gap`,
      };
    },
  };
}
