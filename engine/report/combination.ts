/**
 * The report-combination accounting: for any requested set of `scope × audience`
 * documents, count what the compiled plan actually contains and prove a
 * multi-document request does no duplicate work.
 *
 * V1 does not assume a run always produces the two project reports. A caller may
 * request any non-empty set of distinct targets — project or module, product or
 * developer — and one analysis serves them all. This accounts a compiled
 * `ExecutableReportPlan` (documents, sections, deterministic/authored blocks,
 * bundles, materialized slices) and verifies the dedup invariants the dual-report
 * contract requires: the same `sliceKey` is materialized once and reused by
 * digest, a module-only request produces zero project-level documents and tasks,
 * and no unrequested document exists.
 *
 * It counts and checks; it compiles nothing and calls no model. The eight-way
 * legal matrix it exercises is the contract's own `LEGAL_COMBINATION_EXAMPLES`.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import { type ReportRequest, isProjectTarget, targetKey } from "../contracts/report/target.js";
import type { ExecutableReportPlan } from "./plan.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** What a compiled request actually contains, counted from the plan and its slices. */
export interface PlanAccounting {
  /** The requested documents, one per target — sorted document ids. */
  readonly documentIds: readonly string[];
  readonly documentCount: number;
  readonly projectDocumentCount: number;
  readonly moduleDocumentCount: number;
  readonly sectionCount: number;
  readonly deterministicBlockCount: number;
  /** Authored-required blocks — one Host Agent task each. */
  readonly authoredTaskCount: number;
  readonly bundleCount: number;
  /** Distinct materialized slices — the number of `sliceKey`s actually compiled. */
  readonly uniqueSliceCount: number;
  /** Total block→slice references across every document — ≥ uniqueSliceCount when slices are shared. */
  readonly sliceReferenceCount: number;
  /** Slices referenced by more than one block — reused by digest, not re-materialized. */
  readonly sharedSliceCount: number;
  /** Stable over the whole accounting — the same plan gives the same digest. */
  readonly accountingDigest: string;
}

/** Count a compiled plan's documents, sections, blocks, bundles and slices. */
export function accountExecutablePlan(executable: ExecutableReportPlan): PlanAccounting {
  const { plan, slices, bundlePlan } = executable;
  const documentIds = [...plan.documents.map((d) => d.documentId)].sort();
  const blocks = plan.documents.flatMap((d) => d.sections.flatMap((s) => s.blocks));
  const authoredTaskCount = blocks.filter((b) => b.task !== undefined).length;

  const projectDocumentCount = plan.documents.filter((d) => d.scope.kind === "project").length;
  const sharedSliceCount = Object.values(slices.refCounts).filter((n) => n > 1).length;

  const accounting: Omit<PlanAccounting, "accountingDigest"> = {
    documentIds,
    documentCount: plan.documents.length,
    projectDocumentCount,
    moduleDocumentCount: plan.documents.length - projectDocumentCount,
    sectionCount: plan.documents.reduce((n, d) => n + d.sections.length, 0),
    deterministicBlockCount: blocks.length - authoredTaskCount,
    authoredTaskCount,
    bundleCount: bundlePlan.bundles.length,
    uniqueSliceCount: slices.slices.length,
    sliceReferenceCount: slices.references.length,
    sharedSliceCount,
  };
  return { ...accounting, accountingDigest: digest(accounting) };
}

export type DedupViolation =
  | "slice-materialized-more-than-once"
  | "referenced-slice-not-materialized"
  | "unrequested-document"
  | "missing-requested-document"
  | "duplicate-document"
  | "module-only-has-project-document";

export type DedupVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly { readonly kind: DedupViolation; readonly detail: string }[] };

/**
 * Verify the dedup and scope invariants a multi-document request must hold:
 *
 * - every `sliceKey` is materialized exactly once (the shared slice is reused by
 *   digest, never re-compiled) and every referenced slice was materialized;
 * - a module-only request produces no project-level document;
 * - every produced document was requested, and every requested target produced
 *   exactly one document.
 *
 * Fail-closed: any imbalance is a listed violation, not a silent pass.
 */
export function verifyDedup(request: ReportRequest, executable: ExecutableReportPlan): DedupVerdict {
  const violations: { kind: DedupViolation; detail: string }[] = [];
  const { plan, slices } = executable;

  // Each materialized slice key is unique; each reference resolves to one.
  const materialized = new Map<string, number>();
  for (const slice of slices.slices) materialized.set(slice.sliceKey, (materialized.get(slice.sliceKey) ?? 0) + 1);
  for (const [key, count] of materialized) {
    if (count > 1) violations.push({ kind: "slice-materialized-more-than-once", detail: `${key} × ${count}` });
  }
  for (const ref of slices.references) {
    if (!materialized.has(ref.sliceKey)) {
      violations.push({ kind: "referenced-slice-not-materialized", detail: `${ref.documentId}/${ref.blockId} → ${ref.sliceKey}` });
    }
  }

  // Documents match the request one-for-one — nothing unrequested, nothing dropped,
  // nothing duplicated.
  const requested = new Set(request.map(targetKey));
  const producedIds = plan.documents.map((d) => d.documentId);
  const produced = new Set(producedIds);
  if (produced.size !== producedIds.length) {
    const dupes = producedIds.filter((id, i) => producedIds.indexOf(id) !== i);
    for (const id of new Set(dupes)) violations.push({ kind: "duplicate-document", detail: id });
  }
  for (const id of produced) {
    if (!requested.has(id)) violations.push({ kind: "unrequested-document", detail: id });
  }
  for (const id of requested) {
    if (!produced.has(id)) violations.push({ kind: "missing-requested-document", detail: id });
  }

  // Module-only requests never yield a project-level document.
  const moduleOnly = request.length > 0 && request.every((t) => !isProjectTarget(t));
  if (moduleOnly) {
    for (const d of plan.documents) {
      if (d.scope.kind === "project") violations.push({ kind: "module-only-has-project-document", detail: d.documentId });
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * The project-level document and authored-task counts for a request — both zero
 * for a module-only request. A module report must assemble on its own, with no
 * project-level document or task compiled alongside it.
 */
export function projectLevelFootprint(executable: ExecutableReportPlan): {
  readonly projectDocumentCount: number;
  readonly projectTaskCount: number;
} {
  const projectDocs = executable.plan.documents.filter((d) => d.scope.kind === "project");
  const projectTaskCount = projectDocs
    .flatMap((d) => d.sections.flatMap((s) => s.blocks))
    .filter((b) => b.task !== undefined).length;
  return { projectDocumentCount: projectDocs.length, projectTaskCount };
}
