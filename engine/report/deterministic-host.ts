/**
 * The deterministic Host Agent (PI-21/22/23): a model-free host that satisfies the
 * execution seam `executeAuthoredTasks` drives, so the engine's Host Agent boundary
 * stays exactly as it is under a real LLM host.
 *
 * It calls no model. An authored task is accepted (and its block validates) when
 * there is a legitimate basis for the prose the LLM will later author: the task's
 * OWN bounded slice — the block's declared fact kinds, the same slice the
 * deterministic renderer reads — resolves at least one cited fact, OR the block's
 * section carries an honest not-applicable / unknown applicability decision the
 * block will disclose. A task with neither is left a marked gap.
 *
 * The rule is the block's own kinds, never the section union: an authored block
 * whose narrow slice is empty is a gap even when a sibling block in the same
 * section is grounded. So the host never validates a block against facts it does
 * not itself read, and its `validatedTaskIds` verdict never disagrees with what the
 * block renders — a required authored block with no grounding is never silently
 * passed by borrowing a sibling's evidence.
 *
 * The prose itself is deferred: the validated artifact is a reference to the
 * deterministic fact digest, and the audience-specific text is the LLM authoring
 * phase's to write. Deterministic over the frozen KB and the plan.
 */

import type { AttemptReceipt, AuthoredBlockTask, HostAgent } from "../contracts/report/pipeline.js";
import type { SectionApplicabilityDecision } from "./applicability.js";
import type { DecisionIndex } from "./deterministic-content.js";
import { type SliceReaders, resolveSliceFacts } from "./slice-resolve.js";

export interface DeterministicHostOptions {
  readonly readers: SliceReaders;
  readonly decisions: DecisionIndex;
}

function legitimateDisclosure(decision: SectionApplicabilityDecision | undefined): boolean {
  return decision !== undefined && (decision.applicability === "not-applicable" || decision.applicability === "unknown");
}

/**
 * Build the deterministic host. Each authored task is validated iff its own bounded
 * slice resolves ≥1 cited fact or its section carries an honest not-applicable /
 * unknown decision; otherwise the attempt is rejected and the block is left a
 * marked gap — the same verdict the renderer reaches for that block.
 */
export function deterministicHost(options: DeterministicHostOptions): HostAgent {
  return {
    execute(task: AuthoredBlockTask): Omit<AttemptReceipt, "attempt" | "taskId"> {
      const base = { executorKind: task.identity.executorKind, modelId: task.identity.modelId };

      // The block's OWN slice — exactly what the deterministic renderer reads. Never
      // the section union: a block is judged on the facts it itself declares.
      const blockFacts = resolveSliceFacts(options.readers, task.factSlice.scope, task.factSlice.factKinds);
      const decision = options.decisions.get(task.documentId)?.get(task.sectionId);

      if (blockFacts.length >= 1) {
        return {
          ...base,
          outcome: "accepted",
          artifactRef: `fact-digest://${task.taskId}`,
          validationOk: true,
          detail: `grounded by ${blockFacts.length} cited fact(s) in its own slice; prose deferred to the LLM host`,
        };
      }
      if (legitimateDisclosure(decision)) {
        return {
          ...base,
          outcome: "accepted",
          artifactRef: `fact-digest://${task.taskId}`,
          validationOk: true,
          detail: `structured ${decision!.applicability} disclosure for ${task.sectionId}; prose deferred to the LLM host`,
        };
      }
      return {
        ...base,
        outcome: "rejected",
        artifactRef: null,
        validationOk: false,
        detail: `no cited facts in its own slice (${task.factSlice.factKinds.join(", ")}) and no not-applicable/unknown decision for ${task.sectionId} — left a marked gap`,
      };
    },
  };
}
