/**
 * The executable report plan: PI-41 applicability, PI-42 slices and PI-80 bundles
 * converged into one plan a Host Agent can run and a caller can preview.
 *
 * `compileExecutablePlan` is the single entry the downstream host and the dual-
 * report presets use. It threads applicability into the plan compiler's seam
 * (a not-applicable section is omitted; an unknown one is kept and disclosed, so
 * the two are never conflated), materializes the bounded slices once across all
 * documents, compiles the budget-controlled bundles, and returns a machine-
 * readable preview together with the per-section applicability decisions and one
 * audit digest over the whole thing.
 *
 * It does not create a parallel planner: the compilation, slices and bundles are
 * PI-14/42/80's; this converges them and records why each section is in or out.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import { joinKey } from "../contracts/shared-fact/serialization.js";
import {
  type GenerationParams,
  type ReportPlan,
  compileReportPlan,
} from "../contracts/report/pipeline.js";
import { type ReportRequest, type ReportTarget, targetKey } from "../contracts/report/target.js";
import type { AnalysisSnapshotIdentity } from "../contracts/report/snapshot.js";
import type { SectionDefinition } from "../contracts/report/catalog.js";
import type { CoverageInput } from "../contracts/shared-fact/applicability.js";
import {
  type KindCoverageInput,
  type SectionApplicabilityDecision,
  determineSectionApplicability,
} from "./applicability.js";
import {
  type MaterializedSlices,
  type SliceBoundsBySection,
  type SliceCompileContext,
  materializeSlices,
  planSliceAuditDigest,
} from "./slice.js";
import {
  type BundlePlan,
  type ExecutionPreview,
  type PolicyLimits,
  STANDARD_V1_LIMITS,
  compileExecutionBundles,
  previewExecution,
} from "./bundle.js";

/** A section's applicability decision, tagged with the document it was made for. */
export interface ScopedApplicabilityDecision {
  readonly documentId: string;
  readonly decision: SectionApplicabilityDecision;
}

export interface ExecutablePlanRequest {
  readonly request: ReportRequest;
  readonly snapshot: AnalysisSnapshotIdentity;
  readonly params: GenerationParams;
  readonly analysisRunId: string;
  /**
   * Per (target, section) coverage of each declared fact kind. The applicability
   * of the section follows from it (PI-41). Default: every kind is found, so every
   * section is included — callers narrow it with real coverage.
   */
  readonly coverage?: (target: ReportTarget, section: SectionDefinition) => readonly KindCoverageInput[];
  readonly boundsBySection?: SliceBoundsBySection;
  readonly limits?: PolicyLimits;
}

export interface ExecutableReportPlan {
  readonly plan: ReportPlan;
  readonly slices: MaterializedSlices;
  readonly bundlePlan: BundlePlan;
  readonly preview: ExecutionPreview;
  /** Every section's applicability decision — included, not-applicable or unknown, with its reason. */
  readonly applicability: readonly ScopedApplicabilityDecision[];
  /** One digest over the plan, its slices, the policy and the applicability decisions. */
  readonly auditDigest: string;
}

/** A completed, capable, well-scoped run that found the kind — the default coverage. */
function foundCoverage(): CoverageInput {
  return {
    capable: true,
    providerRan: true,
    scopeDefined: true,
    evidencePresent: true,
    notApplicableConfirmed: false,
    failed: false,
    truncated: false,
    conflict: false,
  };
}

function defaultCoverage(_target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] {
  return section.inputFactKinds.map((kind) => ({ kind, coverage: foundCoverage() }));
}

/**
 * Compile one request into an executable plan. Applicability is decided per
 * (target, section) and threaded into the compiler so a not-applicable section is
 * omitted while an unknown one is kept; the decisions are recorded so nothing is
 * conflated. Slices are materialized once across every document and bundles are
 * budget-compiled. Deterministic: the same inputs give the same plan and audit digest.
 */
export function compileExecutablePlan(input: ExecutablePlanRequest): ExecutableReportPlan {
  const coverageOf = input.coverage ?? defaultCoverage;
  const collected: ScopedApplicabilityDecision[] = [];
  const memo = new Map<string, SectionApplicabilityDecision>();

  const applicabilityOf = (target: ReportTarget, section: SectionDefinition) => {
    const key = joinKey([targetKey(target), section.id]);
    let decision = memo.get(key);
    if (decision === undefined) {
      decision = determineSectionApplicability({
        sectionId: section.id,
        requirement: section.requirement,
        kinds: coverageOf(target, section),
      });
      memo.set(key, decision);
      collected.push({ documentId: targetKey(target), decision });
    }
    return decision.applicability;
  };

  const plan = compileReportPlan({
    request: input.request,
    snapshot: input.snapshot,
    params: input.params,
    applicability: applicabilityOf,
  });

  const context: SliceCompileContext = { analysisRunId: input.analysisRunId, schemaVersion: input.snapshot.schemaVersion };
  const slices = materializeSlices(plan, context, input.boundsBySection ?? {});
  const limits = input.limits ?? STANDARD_V1_LIMITS;
  const bundlePlan = compileExecutionBundles(plan, slices, limits);
  const preview = previewExecution(plan, slices, limits);

  const applicability = [...collected].sort((a, b) => {
    const ak = joinKey([a.documentId, a.decision.sectionId]);
    const bk = joinKey([b.documentId, b.decision.sectionId]);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const auditDigest = createHash("sha256")
    .update(
      stableStringify({
        planDigest: plan.planDigest,
        sliceAudit: planSliceAuditDigest(plan, slices),
        policyId: bundlePlan.policyId,
        applicability: applicability.map((a) => ({
          documentId: a.documentId,
          sectionId: a.decision.sectionId,
          applicability: a.decision.applicability,
          state: a.decision.state,
        })),
      }),
    )
    .digest("hex");

  return { plan, slices, bundlePlan, preview, applicability, auditDigest };
}

/**
 * The applicability decisions a plan omitted (not-applicable) versus kept but
 * could not establish (unknown) — the two a report must not conflate. Included
 * sections are in the plan; these are the accounting for the rest.
 */
export function applicabilityBreakdown(executable: ExecutableReportPlan): {
  readonly included: readonly ScopedApplicabilityDecision[];
  readonly notApplicable: readonly ScopedApplicabilityDecision[];
  readonly unknown: readonly ScopedApplicabilityDecision[];
} {
  const by = (kind: SectionApplicabilityDecision["applicability"]) =>
    executable.applicability.filter((a) => a.decision.applicability === kind);
  return { included: by("included"), notApplicable: by("not-applicable"), unknown: by("unknown") };
}
