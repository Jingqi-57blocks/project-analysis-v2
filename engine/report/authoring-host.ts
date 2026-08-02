/**
 * The prose-authoring Host Agent (PI-21/22 step 2): a model-AGNOSTIC host that
 * satisfies the exact same `HostAgent` seam the deterministic host does, so the
 * engine's Host Agent boundary is unchanged. It calls no vendor SDK; it invokes an
 * injected `ProseAuthor` callback and validates whatever prose comes back.
 *
 * Per authored task it resolves the block's OWN bounded slice — the same slice the
 * deterministic renderer reads, never the section union:
 *   - empty slice + a not-applicable/unknown section decision → accepted as a
 *     structured disclosure, exactly as the deterministic host does (no prose);
 *   - empty slice + no such decision → rejected, a marked gap;
 *   - ≥1 cited fact → the author is called with the block's authoring request and
 *     the attempt number, and the returned prose is checked by `validateGrounding`.
 *     On a grounded pass the prose and its grounded fact-id set are written to the
 *     prose store and the task is accepted; on a fail (foreign citation, value
 *     mismatch, or no citation) the attempt is rejected with the ungrounded claims
 *     in its detail, feeding the engine's existing retry/gap loop.
 *
 * The host tracks its own per-task attempt count (the execution seam passes the task
 * but not the attempt), so a retrying author sees a rising attempt number — the same
 * pattern the fake host uses. Deterministic given a deterministic author.
 */

import { sectionById } from "../contracts/report/catalog.js";
import type { AttemptReceipt, AuthoredBlockTask, HostAgent } from "../contracts/report/pipeline.js";
import type { SectionApplicabilityDecision } from "./applicability.js";
import type { DecisionIndex } from "./deterministic-content.js";
import {
  type AuthoredPromptContract,
  type AuthoringRequest,
  composeAuthorPrompt,
  formatIndexedDigest,
} from "./author-prompt.js";
import { type GroundingResult, validateGrounding } from "./grounding.js";
import { type CitedFact, type SliceReaders, resolveSliceFacts } from "./slice-resolve.js";
import type { Audience } from "../contracts/report/target.js";

/** What one accepted authored block leaves in the store — the prose, its grounded facts, and the ordered slice. */
export interface ProseArtifact {
  readonly prose: string;
  readonly groundedFactIds: readonly string[];
  /** The block's ordered cited facts — kept so `[n]` markers can be expanded at render. */
  readonly facts: readonly CitedFact[];
}

/** taskId → the accepted prose artifact. Filled by the host, read by `authoredContent`. */
export type ProseStore = Map<string, ProseArtifact>;

/** The injected author. Returns prose for the request, or null when it produced none. */
export type ProseAuthor = (request: AuthoringRequest, attempt: number) => { readonly prose: string } | null;

export interface AuthoringHostOptions {
  readonly readers: SliceReaders;
  readonly decisions: DecisionIndex;
  readonly contractsByBlockId: ReadonlyMap<string, AuthoredPromptContract>;
  readonly author: ProseAuthor;
  readonly proseStore: ProseStore;
}

function legitimateDisclosure(decision: SectionApplicabilityDecision | undefined): boolean {
  return decision !== undefined && (decision.applicability === "not-applicable" || decision.applicability === "unknown");
}

function audienceOfDocument(documentId: string): Audience {
  return documentId.endsWith("|developer") ? "developer" : "product";
}

/** A generic contract for an authored block that has no registered content contract. */
function fallbackContract(task: AuthoredBlockTask): AuthoredPromptContract {
  return {
    blockId: task.blockId,
    outputSchemaId: task.outputSchemaId,
    inputFactKinds: task.factSlice.factKinds,
    prompt: "Author this block's prose, grounded strictly in the cited facts below.",
  };
}

function buildRequest(
  task: AuthoredBlockTask,
  facts: readonly CitedFact[],
  contractsByBlockId: ReadonlyMap<string, AuthoredPromptContract>,
): AuthoringRequest {
  const audience = audienceOfDocument(task.documentId);
  const contract = contractsByBlockId.get(task.blockId) ?? fallbackContract(task);
  const sectionTitle = sectionById(task.sectionId)?.title ?? task.sectionId;
  return {
    taskId: task.taskId,
    documentId: task.documentId,
    sectionId: task.sectionId,
    blockId: task.blockId,
    audience,
    prompt: composeAuthorPrompt(contract, sectionTitle, audience, facts),
    digest: formatIndexedDigest(facts),
    facts,
  };
}

function rejectionDetail(grounding: GroundingResult): string {
  const claims = grounding.ungrounded.map((c) => `${c.kind}: ${c.detail}`).join("; ");
  return `ungrounded prose rejected — ${claims}`;
}

/**
 * Build the prose-authoring host. Each authored task is grounded on its own slice: a
 * grounded pass writes to the prose store and accepts (`authored-prose://<taskId>`);
 * a fail rejects with the ungrounded claims; an empty slice is a structured
 * disclosure or a marked gap, exactly as the deterministic host decides it.
 */
export function authoringHost(options: AuthoringHostOptions): HostAgent {
  const attemptsByTask = new Map<string, number>();

  return {
    execute(task: AuthoredBlockTask): Omit<AttemptReceipt, "attempt" | "taskId"> {
      const base = { executorKind: task.identity.executorKind, modelId: task.identity.modelId };
      const attempt = (attemptsByTask.get(task.taskId) ?? 0) + 1;
      attemptsByTask.set(task.taskId, attempt);

      const facts = resolveSliceFacts(options.readers, task.factSlice.scope, task.factSlice.factKinds);
      const decision = options.decisions.get(task.documentId)?.get(task.sectionId);

      // Empty slice — no prose to author. Mirror the deterministic host exactly: a
      // structured disclosure when the section is honestly not-applicable/unknown,
      // otherwise a marked gap. Nothing is written to the prose store.
      if (facts.length === 0) {
        if (legitimateDisclosure(decision)) {
          return {
            ...base,
            outcome: "accepted",
            artifactRef: `fact-digest://${task.taskId}`,
            validationOk: true,
            detail: `structured ${decision!.applicability} disclosure for ${task.sectionId}; no prose authored`,
          };
        }
        return {
          ...base,
          outcome: "rejected",
          artifactRef: null,
          validationOk: false,
          detail: `no cited facts in its own slice (${task.factSlice.factKinds.join(", ")}) and no not-applicable/unknown decision for ${task.sectionId} — left a marked gap`,
        };
      }

      // ≥1 cited fact — the block must carry grounded prose. Ask the injected author,
      // then validate; the engine crosses no model boundary itself.
      const request = buildRequest(task, facts, options.contractsByBlockId);
      const authored = options.author(request, attempt);
      if (authored === null) {
        return {
          ...base,
          outcome: "rejected",
          artifactRef: null,
          validationOk: false,
          detail: `author produced no prose for ${task.blockId} on attempt ${attempt}`,
        };
      }

      const grounding = validateGrounding(authored.prose, facts);
      if (!grounding.ok) {
        return { ...base, outcome: "rejected", artifactRef: null, validationOk: false, detail: rejectionDetail(grounding) };
      }

      options.proseStore.set(task.taskId, { prose: authored.prose, groundedFactIds: grounding.groundedFactIds, facts });
      return {
        ...base,
        outcome: "accepted",
        artifactRef: `authored-prose://${task.taskId}`,
        validationOk: true,
        detail: `grounded prose: ${grounding.groundedFactIds.length} of ${facts.length} cited fact(s) cited`,
      };
    },
  };
}
