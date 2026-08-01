/**
 * Budget-controlled ExecutionBundle compilation and the block-level execution model.
 *
 * A section is reader structure; an ExecutionBundle is one external Host Agent
 * call. The two-layer split (PI-14) lets many authored blocks share one call
 * without sharing a fate: a bundle carries the de-duplicated union of its members'
 * slices, the host returns output keyed by block id, and each block is validated,
 * accounted and retried on its own.
 *
 * Grouping is deterministic and bounded. Authored blocks bundle together only when
 * they share a document, audience, scope, dependency wave and affinity — never
 * across audiences or scopes. Within a group, blocks pack into bundles under the
 * policy's input-byte cap in stable block order; a group that exceeds the cap
 * splits at a stable boundary, and a single block whose slice alone exceeds the
 * cap fails closed (budget-exceeded) rather than being silently truncated or
 * having its source re-read.
 *
 * On execution, a failed block is retried alone — its passed siblings are kept,
 * not regenerated. Required authored blocks that never validate leave the run
 * incomplete: a deterministic skeleton may ship, a placeholder may not. Every
 * block writes its own artifact, so concurrency never appends to one document; the
 * assembler consumes only validated block artifacts.
 *
 * This compiles and accounts; it calls no model. A fake Host Agent satisfies the
 * same seam a real one does.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import { joinKey } from "../contracts/shared-fact/serialization.js";
import type { ReportPlan } from "../contracts/report/pipeline.js";
import type { Audience, Scope } from "../contracts/report/target.js";
import { type BlockFailureKind, type MaterializedSlices } from "./slice.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function scopeId(scope: Scope): string {
  return scope.kind === "project" ? "project" : `module:${scope.moduleId}`;
}

// ---------------------------------------------------------------------------
// The versioned V1 execution policy.
// ---------------------------------------------------------------------------

/**
 * The internal `standard-v1` execution limits. Versioned, not a user-facing depth
 * tier: the report combination is chosen by the ReportRequest, the execution
 * strategy is a fixed internal contract.
 */
export interface PolicyLimits {
  readonly policyId: string;
  /** Max serialized input bytes a single bundle may carry. */
  readonly bundleInputByteCap: number;
  readonly tokenEstimatorVersion: string;
  /** Max output bytes a block may return before it fails. */
  readonly outputByteCap: number;
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  /** The failure a block gets when it alone exceeds a cap. */
  readonly overLimitFailure: BlockFailureKind;
}

export const STANDARD_V1_LIMITS: PolicyLimits = {
  policyId: "standard-v1",
  bundleInputByteCap: 16_000,
  tokenEstimatorVersion: "token-estimate-v1",
  outputByteCap: 8_000,
  maxConcurrency: 4,
  maxRetries: 2,
  overLimitFailure: "budget-exceeded",
};

// ---------------------------------------------------------------------------
// Bundle compilation.
// ---------------------------------------------------------------------------

interface AuthoredBlockView {
  readonly documentId: string;
  readonly audience: Audience;
  readonly scopeId: string;
  readonly wave: number;
  readonly sectionId: string;
  readonly blockId: string;
  readonly taskId: string;
  readonly sliceKey: string;
  readonly affinityKey: string;
}

/** Authored blocks with the slice/audience/scope/wave context bundling needs. */
function authoredBlockViews(plan: ReportPlan, slices: MaterializedSlices): AuthoredBlockView[] {
  // Each block's materialized (full) slice key — the one the slice table is keyed
  // by, not PI-14's narrower per-plan hint — so byte lookups resolve.
  const fullKeyByBlock = new Map<string, string>();
  for (const ref of slices.references) {
    fullKeyByBlock.set(joinKey([ref.documentId, ref.sectionId, ref.blockId]), ref.sliceKey);
  }

  const views: AuthoredBlockView[] = [];
  for (const document of plan.documents) {
    for (const section of document.sections) {
      for (const block of section.blocks) {
        if (block.task === undefined) continue;
        views.push({
          documentId: document.documentId,
          audience: document.audience,
          scopeId: scopeId(document.scope),
          wave: section.wave,
          sectionId: section.sectionId,
          blockId: block.blockId,
          taskId: block.task.taskId,
          sliceKey: fullKeyByBlock.get(joinKey([document.documentId, section.sectionId, block.blockId])) ?? block.factSlice.sliceKey,
          // V1 affinity: all authored blocks in one document/audience/scope/wave
          // are bundle-compatible. A distinct affinity would keep blocks apart
          // without changing content identity; none is needed in V1.
          affinityKey: "standard",
        });
      }
    }
  }
  return views;
}

export interface CompiledBundle {
  readonly bundleId: string;
  readonly documentId: string;
  readonly audience: Audience;
  readonly scopeId: string;
  readonly wave: number;
  readonly affinityKey: string;
  readonly taskIds: readonly string[];
  /** The de-duplicated union of the member blocks' slice keys. */
  readonly sliceKeys: readonly string[];
  readonly inputBytes: number;
  /** Which split within its group — 0 unless the group exceeded the cap. */
  readonly splitIndex: number;
}

export interface BundleFailure {
  readonly blockId: string;
  readonly taskId: string;
  readonly failure: BlockFailureKind;
  readonly reason: string;
}

export interface BundlePlan {
  readonly bundles: readonly CompiledBundle[];
  /** Blocks that failed closed at compile — a single block over the input cap. */
  readonly failures: readonly BundleFailure[];
  /** Why a group split into more than one bundle, in stable order. */
  readonly splitReasons: readonly string[];
  readonly policyId: string;
}

function groupKey(view: AuthoredBlockView): string {
  return joinKey([view.documentId, view.audience, view.scopeId, String(view.wave), view.affinityKey]);
}

/** The serialized size of a slice, from the materialized table (0 if absent). */
function sliceBytesOf(slices: MaterializedSlices): (sliceKey: string) => number {
  const byKey = new Map(slices.slices.map((s) => [s.sliceKey, Buffer.byteLength(stableStringify(s), "utf8")] as const));
  return (sliceKey) => byKey.get(sliceKey) ?? 0;
}

/**
 * Compile authored blocks into bundles. Deterministic: the same plan, slices and
 * policy give the same bundles and bundle ids. Groups never cross audience or
 * scope; a group that exceeds the input cap splits at a stable block boundary; a
 * single block whose slice alone exceeds the cap fails closed rather than merging
 * over budget or truncating.
 */
export function compileExecutionBundles(
  plan: ReportPlan,
  slices: MaterializedSlices,
  limits: PolicyLimits = STANDARD_V1_LIMITS,
): BundlePlan {
  const bytesOf = sliceBytesOf(slices);
  const views = authoredBlockViews(plan, slices);

  const groups = new Map<string, AuthoredBlockView[]>();
  for (const view of views) {
    const key = groupKey(view);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(view);
  }

  const bundles: CompiledBundle[] = [];
  const failures: BundleFailure[] = [];
  const splitReasons: string[] = [];

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    // Stable block order within the group: by section, then block id.
    const ordered = [...group].sort((a, b) =>
      a.sectionId !== b.sectionId ? (a.sectionId < b.sectionId ? -1 : 1) : a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0,
    );

    let splitIndex = 0;
    let current: AuthoredBlockView[] = [];
    let currentKeys = new Set<string>();
    let currentBytes = 0;

    const flush = (): void => {
      if (current.length === 0) return;
      const first = current[0]!;
      const sliceKeys = [...currentKeys].sort();
      bundles.push({
        bundleId: digest({
          documentId: first.documentId,
          audience: first.audience,
          scopeId: first.scopeId,
          wave: first.wave,
          affinityKey: first.affinityKey,
          splitIndex,
          taskIds: current.map((v) => v.taskId),
          policyId: limits.policyId,
        }),
        documentId: first.documentId,
        audience: first.audience,
        scopeId: first.scopeId,
        wave: first.wave,
        affinityKey: first.affinityKey,
        taskIds: current.map((v) => v.taskId),
        sliceKeys,
        inputBytes: currentBytes,
        splitIndex,
      });
      current = [];
      currentKeys = new Set();
      currentBytes = 0;
    };

    for (const view of ordered) {
      const addedBytes = currentKeys.has(view.sliceKey) ? 0 : bytesOf(view.sliceKey);
      const blockAlone = bytesOf(view.sliceKey);
      if (blockAlone > limits.bundleInputByteCap) {
        // One block's slice exceeds the cap: fail closed, never truncate or merge.
        failures.push({
          blockId: view.blockId,
          taskId: view.taskId,
          failure: limits.overLimitFailure,
          reason: `block ${view.blockId} slice is ${blockAlone} bytes, over the ${limits.bundleInputByteCap}-byte bundle cap`,
        });
        continue;
      }
      if (current.length > 0 && currentBytes + addedBytes > limits.bundleInputByteCap) {
        flush();
        splitIndex += 1;
        splitReasons.push(`group ${key} split at ${view.sectionId}/${view.blockId}: input-byte cap ${limits.bundleInputByteCap} reached`);
      }
      current.push(view);
      if (!currentKeys.has(view.sliceKey)) {
        currentKeys.add(view.sliceKey);
        currentBytes += addedBytes;
      }
    }
    flush();
  }

  return { bundles, failures, splitReasons, policyId: limits.policyId };
}

// ---------------------------------------------------------------------------
// Execution: per-block validation, retry-only-failed, receipts and accounting.
// ---------------------------------------------------------------------------

export interface BlockValidation {
  readonly blockId: string;
  readonly taskId: string;
  readonly ok: boolean;
  readonly failure: BlockFailureKind | null;
}

export interface RetryDecision {
  /** Task ids to retry — failed and still within the retry budget. */
  readonly retry: readonly string[];
  /** Task ids kept as-is — already passed, never regenerated. */
  readonly kept: readonly string[];
  /** Task ids that failed and are out of retries. */
  readonly exhausted: readonly string[];
}

/**
 * Decide what to retry after a bundle runs. A passed block is kept, never
 * regenerated; a failed block is retried alone while it has budget, and marked
 * exhausted once its attempts reach the cap. Deterministic and order-stable.
 */
export function planRetry(
  results: readonly BlockValidation[],
  attemptsByTask: Readonly<Record<string, number>>,
  limits: PolicyLimits = STANDARD_V1_LIMITS,
): RetryDecision {
  const retry: string[] = [];
  const kept: string[] = [];
  const exhausted: string[] = [];
  for (const result of results) {
    if (result.ok) {
      kept.push(result.taskId);
      continue;
    }
    const attempts = attemptsByTask[result.taskId] ?? 1;
    if (attempts < limits.maxRetries + 1) retry.push(result.taskId);
    else exhausted.push(result.taskId);
  }
  return { retry: retry.sort(), kept: kept.sort(), exhausted: exhausted.sort() };
}

export interface BlockExecutionReceipt {
  readonly blockId: string;
  readonly taskId: string;
  readonly wave: number;
  readonly queueMs: number;
  readonly execMs: number;
  readonly validateMs: number;
  readonly attempts: number;
  readonly retries: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly failure: BlockFailureKind | null;
}

export interface RunAccounting {
  readonly deterministicBlockCount: number;
  readonly authoredBlockCount: number;
  readonly bundleCount: number;
  readonly totalAttempts: number;
  /** The longest wave-respecting path in ms: waves run in sequence, bundles within a wave concurrently. */
  readonly criticalPathMs: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

/**
 * Roll up receipts into run accounting. Deterministic block, authored block and
 * bundle counts come from the plan and bundle plan; attempts and tokens sum over
 * receipts; the critical path is the sum over waves of the slowest block in each
 * wave, since waves are sequential and blocks within one run concurrently.
 */
export function accountRun(
  plan: ReportPlan,
  bundlePlan: BundlePlan,
  receipts: readonly BlockExecutionReceipt[],
): RunAccounting {
  const blocks = plan.documents.flatMap((d) => d.sections.flatMap((s) => s.blocks));
  const authoredBlockCount = blocks.filter((b) => b.task !== undefined).length;
  const deterministicBlockCount = blocks.length - authoredBlockCount;

  const elapsed = (r: BlockExecutionReceipt): number => r.queueMs + r.execMs + r.validateMs;
  const slowestByWave = new Map<number, number>();
  for (const r of receipts) {
    slowestByWave.set(r.wave, Math.max(slowestByWave.get(r.wave) ?? 0, elapsed(r)));
  }
  const criticalPathMs = [...slowestByWave.values()].reduce((a, b) => a + b, 0);

  return {
    deterministicBlockCount,
    authoredBlockCount,
    bundleCount: bundlePlan.bundles.length,
    totalAttempts: receipts.reduce((sum, r) => sum + r.attempts, 0),
    criticalPathMs,
    totalInputTokens: receipts.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
    totalOutputTokens: receipts.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Assembly: only validated block artifacts, and a run is complete or it is not.
// ---------------------------------------------------------------------------

export interface BlockArtifact {
  readonly blockId: string;
  readonly taskId: string;
  readonly validated: boolean;
  /** Where this block's output landed. Each block writes its own — never one shared file. */
  readonly artifactRef: string | null;
}

export interface AssemblyResult {
  /** False if any required authored block never validated — the run is not complete. */
  readonly complete: boolean;
  readonly missingRequired: readonly string[];
  /** blockId → artifactRef, validated blocks only. */
  readonly artifactByBlock: Readonly<Record<string, string>>;
}

/**
 * Assemble validated block artifacts. Every required authored block must have a
 * validated artifact for the run to be complete; a missing or unvalidated one
 * leaves the run incomplete (a deterministic partial is allowed, a placeholder is
 * not). Only validated artifacts are consumed, and each is a separate per-block
 * file, so assembly never races on one document.
 */
export function assembleValidatedBlocks(
  plan: ReportPlan,
  artifacts: readonly BlockArtifact[],
): AssemblyResult {
  const validated = new Map<string, string>();
  for (const artifact of artifacts) {
    if (artifact.validated && artifact.artifactRef !== null) validated.set(artifact.blockId, artifact.artifactRef);
  }

  const requiredAuthored = plan.documents
    .flatMap((d) => d.sections.flatMap((s) => s.blocks))
    .filter((b) => b.task !== undefined)
    .map((b) => b.blockId);

  const missingRequired = [...new Set(requiredAuthored.filter((id) => !validated.has(id)))].sort();
  const artifactByBlock: Record<string, string> = {};
  for (const id of [...validated.keys()].sort()) artifactByBlock[id] = validated.get(id)!;

  return { complete: missingRequired.length === 0, missingRequired, artifactByBlock };
}
