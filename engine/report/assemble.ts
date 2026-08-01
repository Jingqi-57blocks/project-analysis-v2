/**
 * The mechanical dual-report assembler (PI-18).
 *
 * It converts a compiled plan and the validated per-block artifacts into an
 * ordered document structure — DocumentPreset → Section → Block, the plan's own
 * order — from which the deterministic Markdown/HTML is rendered. It consumes only
 * validated block artifacts; a required authored block with no validated artifact
 * leaves that document incomplete (a partial skeleton may be produced for
 * diagnosis, but the run is not complete). Each assembled block keeps its source
 * slice digest, its task identity and its validation outcome, so the assembly is
 * auditable.
 *
 * Nothing here calls a model or re-reads source. Assembly is a pure function of the
 * plan, the materialized slices and the artifacts, so the bundle completion order
 * and concurrency can never change the assembled bytes — the document is ordered by
 * the preset, not by when a block finished.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import { joinKey } from "../contracts/shared-fact/serialization.js";
import type { BlockKind } from "../contracts/report/blocks.js";
import type { DocumentPlan, ReportPlan } from "../contracts/report/pipeline.js";
import type { Audience, Scope } from "../contracts/report/target.js";
import type { BlockArtifact } from "./bundle.js";
import type { MaterializedSlices } from "./slice.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export interface AssembledBlock {
  readonly blockId: string;
  readonly kind: BlockKind;
  readonly outputSchemaId: string;
  readonly carriesSharedClaim: boolean;
  /** The authored task that produced this block, or null for a deterministic one. */
  readonly taskId: string | null;
  /** The scope of the slice this block reads — must match the document's scope. */
  readonly sliceScope: Scope;
  /** The materialized slice this block reads and its digest — the block's source of record. */
  readonly sliceKey: string;
  readonly sliceDigest: string | null;
  /** A deterministic block is always accounted; an authored one only when its artifact validated. */
  readonly validated: boolean;
  readonly artifactRef: string | null;
}

export interface AssembledSection {
  readonly sectionId: string;
  readonly title: string;
  readonly order: number;
  readonly blocks: readonly AssembledBlock[];
}

export interface AssembledDocument {
  readonly documentId: string;
  readonly scope: Scope;
  readonly audience: Audience;
  readonly presetId: string;
  readonly sections: readonly AssembledSection[];
  /** False if a required authored block has no validated artifact — a skeleton, not a finished document. */
  readonly complete: boolean;
  /** Task ids of the required authored blocks with no validated artifact, sorted. */
  readonly missingRequired: readonly string[];
  /** Stable over the document's ordered structure, slice digests and validation outcomes. */
  readonly digest: string;
}

export interface AssembledReport {
  readonly documents: readonly AssembledDocument[];
  /** True only when every requested document is complete. */
  readonly complete: boolean;
  readonly digest: string;
}

/**
 * Assemble the compiled plan and validated artifacts into the ordered report
 * structure. Deterministic: the block order is the plan's, each block records its
 * materialized slice digest, and the digests fold only structure and validation
 * outcomes — never wall-clock or completion order.
 */
export function assembleReport(
  plan: ReportPlan,
  slices: MaterializedSlices,
  artifacts: readonly BlockArtifact[],
): AssembledReport {
  // taskId → validated artifactRef (validated only), and the block→slice map.
  const validatedByTask = new Map<string, string>();
  for (const a of artifacts) {
    if (a.validated && a.artifactRef !== null) validatedByTask.set(a.taskId, a.artifactRef);
  }
  const sliceKeyByRef = new Map(
    slices.references.map((r) => [joinKey([r.documentId, r.sectionId, r.blockId]), r.sliceKey] as const),
  );
  const digestByKey = new Map(slices.slices.map((s) => [s.sliceKey, s.sliceDigest] as const));

  const documents = plan.documents.map((doc) => assembleDocument(doc, validatedByTask, sliceKeyByRef, digestByKey));
  return {
    documents,
    complete: documents.every((d) => d.complete),
    digest: digest(documents.map((d) => ({ documentId: d.documentId, digest: d.digest }))),
  };
}

function assembleDocument(
  doc: DocumentPlan,
  validatedByTask: ReadonlyMap<string, string>,
  sliceKeyByRef: ReadonlyMap<string, string>,
  digestByKey: ReadonlyMap<string, string>,
): AssembledDocument {
  const missingRequired = new Set<string>();

  const sections: AssembledSection[] = doc.sections.map((section) => {
    const blocks: AssembledBlock[] = section.blocks.map((block) => {
      const taskId = block.task?.taskId ?? null;
      const sliceKey = sliceKeyByRef.get(joinKey([doc.documentId, section.sectionId, block.blockId])) ?? block.factSlice.sliceKey;
      const sliceDigest = digestByKey.get(sliceKey) ?? null;

      // A deterministic block needs no host and is always accounted; an authored
      // block is accounted only when its task produced a validated artifact.
      const artifactRef = taskId === null ? null : (validatedByTask.get(taskId) ?? null);
      const validated = block.kind === "deterministic" || artifactRef !== null;
      if (block.kind === "authored-required" && !validated && taskId !== null) missingRequired.add(taskId);

      return {
        blockId: block.blockId,
        kind: block.kind,
        outputSchemaId: block.outputSchemaId,
        carriesSharedClaim: block.carriesSharedClaim,
        taskId,
        sliceScope: block.factSlice.scope,
        sliceKey,
        sliceDigest,
        validated,
        artifactRef,
      };
    });
    return { sectionId: section.sectionId, title: section.title, order: section.order, blocks };
  });

  const missing = [...missingRequired].sort();
  const structure = sections.map((s) => ({
    sectionId: s.sectionId,
    order: s.order,
    blocks: s.blocks.map((b) => ({ blockId: b.blockId, sliceDigest: b.sliceDigest, validated: b.validated })),
  }));

  return {
    documentId: doc.documentId,
    scope: doc.scope,
    audience: doc.audience,
    presetId: doc.presetId,
    sections,
    complete: missing.length === 0,
    missingRequired: missing,
    digest: digest({ documentId: doc.documentId, presetId: doc.presetId, structure }),
  };
}
