/**
 * The top-level dual-report step (PI-18): assemble → audit → render, in one place,
 * so "a finding blocks the run" is wiring, not just a boolean.
 *
 * It sequences the compiled plan and the executed artifacts into the finished
 * report: assemble the validated blocks into the ordered structure, audit that
 * structure for cross-document consistency, and render Markdown and HTML from it.
 * A run is `complete` only when every required block validated AND the audit found
 * nothing — the fail-closed guarantee the assembler and audit each hold, enforced
 * together here. A rendered skeleton with marked gaps is always produced for
 * diagnosis, but a document that is not complete is not eligible for formal export.
 *
 * Pure over the plan, slices, artifacts and the block-content function: the same
 * inputs give the same reports, audit and completion verdict.
 */

import { type AssembledReport, assembleReport } from "./assemble.js";
import { type AuditReport, auditReport } from "./audit.js";
import { type BlockContent, type RenderedReport, renderReport } from "./render.js";
import type { ReportPlan } from "../contracts/report/pipeline.js";
import type { MaterializedSlices } from "./slice.js";
import type { BlockArtifact } from "./bundle.js";

export interface DualReportResult {
  readonly assembled: AssembledReport;
  readonly audit: AuditReport;
  /** Markdown + HTML for every document — a skeleton with marked gaps when incomplete. */
  readonly rendered: RenderedReport;
  /** True only when every document is complete and the audit found nothing — the export gate. */
  readonly complete: boolean;
  /** The document ids eligible for formal export: complete run only. */
  readonly exportable: readonly string[];
}

/**
 * Produce the dual report from a compiled plan and its executed artifacts. Assembly
 * consumes only validated blocks; the audit runs on the assembled structure; the
 * render always runs (a marked skeleton is legible for diagnosis). The run is
 * complete only when the assembly is complete and the audit passed — a failing
 * audit or a missing required block blocks completion and formal export, without
 * suppressing the diagnostic skeleton.
 */
export function produceDualReport(
  plan: ReportPlan,
  slices: MaterializedSlices,
  artifacts: readonly BlockArtifact[],
  content: BlockContent,
): DualReportResult {
  const assembled = assembleReport(plan, slices, artifacts);
  const audit = auditReport(assembled);
  const rendered = renderReport(assembled, content);
  const complete = assembled.complete && audit.ok;
  // Only when the whole run is complete is any document exportable — a partial run
  // exports nothing formally, even its individually-complete documents, because a
  // cross-document audit finding taints the set.
  const exportable = complete ? [...assembled.documents.map((d) => d.documentId)].sort() : [];
  return { assembled, audit, rendered, complete, exportable };
}
