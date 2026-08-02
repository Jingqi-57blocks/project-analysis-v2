/**
 * The authoring prompt layer (PI-21/22 step 2): the model-agnostic seam that turns a
 * block's bounded cited-fact slice into the request a `ProseAuthor` (a model, in
 * phase B) writes prose from. The engine composes the request and validates the
 * answer (grounding.ts); it never calls a model itself.
 *
 * The cited-fact digest formatting is factored out here and reused by the
 * deterministic renderer, so the digest a reader sees and the digest an author is
 * given are the same bytes. `formatIndexedDigest` numbers the facts 1..n in the
 * resolver's stable fact-id order, which is exactly the `[n]` citation index the
 * grounding validator resolves.
 *
 * `composeAuthorPrompt` layers the already-authored block contract prompt (the
 * voice, anti-fabrication and anti-roadmap rules the content leaves define) with the
 * section/audience framing, the indexed digest, and the cite-every-claim
 * instruction. `buildAuthoringRequests` emits one request per authored block whose
 * OWN slice resolves ≥1 fact — the block set phase B must author.
 *
 * Pure over the plan, the readers and the contracts: the same inputs give the same
 * requests, byte for byte.
 */

import { stableStringify } from "../contracts/shared-fact/merge.js";
import type { SourceRef } from "../contracts/shared-fact/provenance.js";
import type { FactKind } from "../contracts/shared-fact/families.js";
import type { Audience } from "../contracts/report/target.js";
import type { ReportPlan } from "../contracts/report/pipeline.js";
import { type CitedFact, type SliceReaders, resolveSliceFacts } from "./slice-resolve.js";
import type { DecisionIndex } from "./deterministic-content.js";

/** Default characters of a fact's verbatim value shown before truncation. */
export const DEFAULT_VALUE_CAP = 200;

/** `root/relPath:line` — the reader-facing citation, with a line range when it has one. */
export function citationLabel(citation: SourceRef): string {
  const path = `${citation.rootName}/${citation.relPath}`;
  if (citation.startLine === null) return path;
  const line =
    citation.endLine !== null && citation.endLine !== citation.startLine
      ? `${citation.startLine}-${citation.endLine}`
      : `${citation.startLine}`;
  return `${path}:${line}`;
}

/** A fact's verbatim value as one stable, bounded line. */
export function valueLabel(value: unknown, valueCap: number = DEFAULT_VALUE_CAP): string {
  const text = stableStringify(value).replace(/\s+/g, " ");
  return text.length > valueCap ? `${text.slice(0, valueCap)}…` : text;
}

/** One fact's cited line: `[factId] «value» (kind) — root/relPath:line`. The shared unit. */
export function citedFactLine(fact: CitedFact, valueCap: number = DEFAULT_VALUE_CAP): string {
  return `[${fact.factId}] «${valueLabel(fact.value, valueCap)}» (${fact.kind}) — ${citationLabel(fact.citation)}`;
}

/**
 * The indexed cited-fact digest: one line per fact, numbered 1..n in the resolver's
 * stable fact-id order. The number is the `[n]` a citation marker resolves to.
 */
export function formatIndexedDigest(facts: readonly CitedFact[], options?: { readonly valueCap?: number }): string {
  const valueCap = options?.valueCap ?? DEFAULT_VALUE_CAP;
  if (facts.length === 0) return "_[no cited facts in this block's slice]_";
  return facts.map((fact, i) => `${i + 1}. ${citedFactLine(fact, valueCap)}`).join("\n");
}

/**
 * The minimal shape of an authored-block contract this layer reads. The content
 * leaves' `AuthoredBlockContract` (with its schema/validator fields) is a structural
 * supertype, so any of them is accepted as one of these.
 */
export interface AuthoredPromptContract {
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly inputFactKinds: readonly FactKind[];
  readonly prompt: string;
}

/** One authoring request — everything a `ProseAuthor` needs, and the engine records. */
export interface AuthoringRequest {
  readonly taskId: string;
  readonly documentId: string;
  readonly sectionId: string;
  readonly blockId: string;
  readonly audience: Audience;
  /** The full instruction: contract prompt + framing + indexed digest + cite rule. */
  readonly prompt: string;
  /** The indexed cited-fact digest text (also embedded in `prompt`). */
  readonly digest: string;
  readonly facts: readonly CitedFact[];
}

const audienceLabel = (audience: Audience): string => (audience === "product" ? "product manager" : "developer");

const CITE_INSTRUCTION = [
  "Ground every claim strictly in the cited facts below, and cite each claim with a bracketed marker:",
  "use [n] where n is the fact's number in the digest, or the raw [factId].",
  "Quote a fact's value or path only when the cited fact carries it verbatim.",
  "State nothing the cited facts do not support; add no priority, remediation, future work or roadmap.",
].join(" ");

/**
 * Compose the full authoring prompt for one block: the contract's own prompt (voice,
 * anti-fabrication and anti-roadmap rules), the section/audience framing, the indexed
 * cited-fact digest (the only admissible evidence), and the cite-every-claim rule.
 */
export function composeAuthorPrompt(
  contract: AuthoredPromptContract,
  sectionTitle: string,
  audience: Audience,
  facts: readonly CitedFact[],
): string {
  const framing = `Section: ${sectionTitle}\nAudience: ${audienceLabel(audience)}\nBlock: ${contract.blockId}`;
  return [
    contract.prompt,
    framing,
    "Cited facts (the only admissible evidence — cite these and nothing else):",
    formatIndexedDigest(facts),
    CITE_INSTRUCTION,
  ].join("\n\n");
}

function audienceOfDocument(documentId: string): Audience {
  return documentId.endsWith("|developer") ? "developer" : "product";
}

/**
 * Build one `AuthoringRequest` per authored block whose OWN bounded slice resolves
 * ≥1 cited fact — the exact block set phase B must author. A block with an empty
 * slice, a not-applicable section, or no content contract emits no request (it is a
 * structured disclosure or a gap, handled by the host). Deterministic over the plan.
 */
export function buildAuthoringRequests(
  plan: ReportPlan,
  readers: SliceReaders,
  decisions: DecisionIndex,
  contractsByBlockId: ReadonlyMap<string, AuthoredPromptContract>,
): AuthoringRequest[] {
  const requests: AuthoringRequest[] = [];
  for (const doc of plan.documents) {
    const audience = audienceOfDocument(doc.documentId);
    for (const section of doc.sections) {
      // A not-applicable section is disclosed structurally, never authored — skip it
      // even if a stale slice would resolve, so authoring never fights applicability.
      if (decisions.get(doc.documentId)?.get(section.sectionId)?.applicability === "not-applicable") continue;
      for (const block of section.blocks) {
        const task = block.task;
        if (task === undefined) continue; // deterministic block — no prose to author
        const contract = contractsByBlockId.get(block.blockId);
        if (contract === undefined) continue; // no authored-content contract for this block
        const facts = resolveSliceFacts(readers, task.factSlice.scope, task.factSlice.factKinds);
        if (facts.length === 0) continue; // structured disclosure or gap — nothing to ground
        const digest = formatIndexedDigest(facts);
        requests.push({
          taskId: task.taskId,
          documentId: doc.documentId,
          sectionId: section.sectionId,
          blockId: block.blockId,
          audience,
          prompt: composeAuthorPrompt(contract, section.title, audience, facts),
          digest,
          facts,
        });
      }
    }
  }
  return requests;
}
