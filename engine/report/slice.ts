/**
 * Bounded fact slices: exactly the facts a block may read, compiled from the plan.
 *
 * An external Host Agent only ever sees the facts a block declares. This layer
 * turns each block's declared fact kinds (PI-14) into a bounded, versioned slice
 * — allowed kinds, scope, a relationship-depth ceiling and a count cap — with a
 * stable key and digest. Identical slices across documents share one key and are
 * materialized once, so two documents that read the same facts do not re-derive
 * or re-carry them; audience-specific prose stays a separate task, but the input
 * it reads is deduplicated.
 *
 * A fact-slice validator makes the boundary enforceable, not merely declared: a
 * fact of an undeclared kind, past the depth ceiling, or outside the materialized
 * set is rejected rather than quietly widening what a block saw. An overlay seam
 * (include / exclude / replace / reorder) is defined and tested, without a
 * user-facing rule language in V1.
 *
 * This compiles slices from the plan and a supplied fact set; it does not read
 * source or re-run providers. sliceKey folds the analysisRunId and fact schema
 * version, so a slice compiled against one analysis can never be reused for
 * another. It evolves the plan the compiler already produces — it is not a
 * second planner.
 */

import { createHash } from "node:crypto";

import type { FactKind } from "../contracts/shared-fact/families.js";
import { stableStringify } from "../contracts/shared-fact/merge.js";
import { joinKey } from "../contracts/shared-fact/serialization.js";
import type { Scope } from "../contracts/report/target.js";
import type { BlockPlan, ExecutionBundle, ReportPlan } from "../contracts/report/pipeline.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function scopeId(scope: Scope): string {
  return scope.kind === "project" ? "project" : `module:${scope.moduleId}`;
}

/** The versioned defaults for a slice's reach. A slice never traverses further. */
export const DEFAULT_RELATIONSHIP_DEPTH = 1;
export const DEFAULT_COUNT_CAP = 500;
export const SLICE_QUERY_VERSION = "1.0.0";

/**
 * The normalized query behind a slice: the deterministic description of which
 * facts it selects, independent of the analysis it runs against. Two blocks with
 * the same normalized query read the same slice.
 */
export interface NormalizedFactQuery {
  readonly scopeId: string;
  /** Sorted, de-duplicated. `*` means the whole fact base (the ledger block). */
  readonly kinds: readonly FactKind[];
  readonly relationshipDepth: number;
  readonly countCap: number;
  readonly version: string;
}

export interface BoundedFactSlice {
  /** analysisRunId + schema version + normalized query — stable across documents, per analysis. */
  readonly sliceKey: string;
  readonly sliceDigest: string;
  readonly scope: Scope;
  readonly query: NormalizedFactQuery;
}

/** Per-section overrides for a slice's reach; anything omitted takes the default. */
export interface SliceBounds {
  readonly relationshipDepth?: number;
  readonly countCap?: number;
}

/**
 * Per-section slice configuration: the fact-set reach (SliceBounds) plus the
 * prerequisite section outputs a block must wait on. Prerequisites gate a block's
 * timing, not the shared fact set, so they live on the SliceReference and never on
 * the BoundedFactSlice — two blocks reading the same facts still share one slice
 * even when their prerequisites differ.
 */
export interface SectionSliceConfig extends SliceBounds {
  readonly prerequisiteSections?: readonly string[];
}

export function normalizeQuery(
  scope: Scope,
  kinds: readonly FactKind[],
  bounds: SliceBounds = {},
): NormalizedFactQuery {
  return {
    scopeId: scopeId(scope),
    kinds: [...new Set(kinds)].sort(),
    relationshipDepth: bounds.relationshipDepth ?? DEFAULT_RELATIONSHIP_DEPTH,
    countCap: bounds.countCap ?? DEFAULT_COUNT_CAP,
    version: SLICE_QUERY_VERSION,
  };
}

/**
 * The cross-document slice key: analysisRunId + fact schema version + the
 * normalized query. Two blocks in different documents that read the same facts
 * from the same analysis produce the same key, and so share one materialized slice.
 */
export function sliceKeyOf(analysisRunId: string, schemaVersion: string, query: NormalizedFactQuery): string {
  return joinKey([
    analysisRunId,
    schemaVersion,
    query.scopeId,
    query.version,
    String(query.relationshipDepth),
    String(query.countCap),
    ...query.kinds,
  ]);
}

export interface SliceCompileContext {
  readonly analysisRunId: string;
  readonly schemaVersion: string;
}

/** Compile one bounded slice from a scope, its kinds and optional bounds. */
export function compileBoundedSlice(
  context: SliceCompileContext,
  scope: Scope,
  kinds: readonly FactKind[],
  bounds: SliceBounds = {},
): BoundedFactSlice {
  const query = normalizeQuery(scope, kinds, bounds);
  const sliceKey = sliceKeyOf(context.analysisRunId, context.schemaVersion, query);
  return { sliceKey, sliceDigest: digest({ sliceKey, query, scope }), scope, query };
}

// ---------------------------------------------------------------------------
// Materialization — dedup identical slices across the whole plan.
// ---------------------------------------------------------------------------

export interface SliceReference {
  readonly documentId: string;
  readonly sectionId: string;
  readonly blockId: string;
  readonly sliceKey: string;
  /** Section outputs this block must wait on before its slice may be read. */
  readonly prerequisiteSections: readonly string[];
}

export interface MaterializedSlices {
  /** Unique slices, one per sliceKey, ordered by key. Materialized once each. */
  readonly slices: readonly BoundedFactSlice[];
  /** Every block's reference to its slice — the reuse is auditable. */
  readonly references: readonly SliceReference[];
  /** How many blocks read each slice (>1 means a slice is shared). */
  readonly refCounts: Readonly<Record<string, number>>;
  /** The slice-query contract version these slices were compiled under. */
  readonly sliceContractVersion: string;
}

/** Per-section config keyed by sectionId, so a section can widen depth/cap or gate on prerequisites. */
export type SliceBoundsBySection = Readonly<Record<string, SectionSliceConfig>>;

/**
 * Compile and deduplicate every block's slice across the whole plan. A slice key
 * is materialized once however many blocks read it; each block keeps a reference
 * to it. The result is deterministic — slices ordered by key, references in
 * document/section/block order.
 */
export function materializeSlices(
  plan: ReportPlan,
  context: SliceCompileContext,
  boundsBySection: SliceBoundsBySection = {},
): MaterializedSlices {
  const byKey = new Map<string, BoundedFactSlice>();
  const references: SliceReference[] = [];
  const refCounts: Record<string, number> = {};

  for (const document of plan.documents) {
    for (const section of document.sections) {
      for (const block of section.blocks) {
        const config = boundsBySection[section.sectionId] ?? {};
        const slice = compileBoundedSlice(context, block.factSlice.scope, block.factSlice.factKinds, config);
        if (!byKey.has(slice.sliceKey)) byKey.set(slice.sliceKey, slice);
        refCounts[slice.sliceKey] = (refCounts[slice.sliceKey] ?? 0) + 1;
        references.push({
          documentId: document.documentId,
          sectionId: section.sectionId,
          blockId: block.blockId,
          sliceKey: slice.sliceKey,
          // Per block, off the shared slice: two blocks that read the same facts
          // dedup to one slice yet keep their own prerequisite timing.
          prerequisiteSections: [...(config.prerequisiteSections ?? [])].sort(),
        });
      }
    }
  }

  const slices = [...byKey.values()].sort((a, b) => (a.sliceKey < b.sliceKey ? -1 : a.sliceKey > b.sliceKey ? 1 : 0));
  return { slices, references, refCounts, sliceContractVersion: SLICE_QUERY_VERSION };
}

// ---------------------------------------------------------------------------
// The fact-slice validator — the boundary is enforced, not merely declared.
// ---------------------------------------------------------------------------

export type FactSliceViolation = "undeclared-kind" | "depth-exceeded" | "out-of-slice";

/** A reference to one fact a block wants to cite, checked against its slice. */
export interface FactReference {
  readonly factId: string;
  readonly kind: FactKind;
  /** Relationship hops from the slice's scope root to this fact. */
  readonly depth: number;
}

export type FactSliceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly violation: FactSliceViolation; readonly reason: string };

/**
 * Check one fact reference against a slice. Rejects a fact of an undeclared kind,
 * one past the relationship-depth ceiling, or — when the materialized id set is
 * supplied — one outside the slice. A `*` slice admits any kind (the fact ledger),
 * but still enforces depth and the id set.
 */
export function validateFactAgainstSlice(
  slice: BoundedFactSlice,
  ref: FactReference,
  materializedIds?: ReadonlySet<string>,
): FactSliceCheck {
  const kinds = new Set(slice.query.kinds);
  if (!kinds.has("*") && !kinds.has(ref.kind)) {
    return { ok: false, violation: "undeclared-kind", reason: `fact kind ${ref.kind} is not declared by this slice` };
  }
  if (ref.depth > slice.query.relationshipDepth) {
    return {
      ok: false,
      violation: "depth-exceeded",
      reason: `fact at depth ${ref.depth} exceeds the slice depth ceiling ${slice.query.relationshipDepth}`,
    };
  }
  if (materializedIds !== undefined && !materializedIds.has(ref.factId)) {
    return { ok: false, violation: "out-of-slice", reason: `fact ${ref.factId} is outside the materialized slice` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The overlay seam — include / exclude / replace / reorder, no user DSL in V1.
// ---------------------------------------------------------------------------

export type SectionOverlayOp =
  | { readonly op: "include"; readonly sectionId: string }
  | { readonly op: "exclude"; readonly sectionId: string }
  | { readonly op: "replace"; readonly sectionId: string; readonly withSectionId: string }
  | { readonly op: "reorder"; readonly order: readonly string[] };

export interface SectionOverlay {
  readonly ops: readonly SectionOverlayOp[];
}

export const EMPTY_OVERLAY: SectionOverlay = { ops: [] };

/**
 * Apply an overlay to a section-id order, deterministically and in op order.
 * `include` appends an id not already present; `exclude` removes one; `replace`
 * swaps an id in place; `reorder` fixes the order of the ids it names, keeping any
 * it does not name in their existing relative order after them. The seam exists
 * so a future caller can adjust a plan without a rule language — V1 ships the
 * mechanism, not a configuration surface.
 */
export function applyOverlay(sectionIds: readonly string[], overlay: SectionOverlay): readonly string[] {
  let ids = [...sectionIds];
  for (const op of overlay.ops) {
    switch (op.op) {
      case "include":
        if (!ids.includes(op.sectionId)) ids.push(op.sectionId);
        break;
      case "exclude":
        ids = ids.filter((id) => id !== op.sectionId);
        break;
      case "replace":
        // Renaming onto an id that already exists would duplicate it; when the
        // target is already present, drop the source rather than create a twin.
        ids = ids.includes(op.withSectionId)
          ? ids.filter((id) => id !== op.sectionId)
          : ids.map((id) => (id === op.sectionId ? op.withSectionId : id));
        break;
      case "reorder": {
        // De-duplicate the requested order so a repeated id cannot duplicate a section.
        const named = [...new Set(op.order)].filter((id) => ids.includes(id));
        const rest = ids.filter((id) => !named.includes(id));
        ids = [...named, ...rest];
        break;
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Failure taxonomy and plan preview — the plan is inspectable before it runs.
// ---------------------------------------------------------------------------

export const BLOCK_FAILURE_KINDS = [
  "slice-violation",
  "validation-failed",
  "budget-exceeded",
  "unmet-prerequisite",
  "executor-error",
] as const;

/**
 * How a block task can fail — a closed classification, so no failure is untyped.
 * Derived from BLOCK_FAILURE_KINDS, so the union and the list can never drift.
 */
export type BlockFailureKind = (typeof BLOCK_FAILURE_KINDS)[number];

export const TOKEN_ESTIMATOR_VERSION = "token-estimate-v1";

/** A rough, versioned token estimate from the serialized input size (~4 bytes/token). */
export function estimateTokens(serializedBytes: number): number {
  return Math.ceil(serializedBytes / 4);
}

export interface PlanPreview {
  readonly blockCount: number;
  readonly authoredBlockCount: number;
  readonly bundleCount: number;
  readonly sliceCount: number;
  readonly sharedSliceCount: number;
  /** UTF-8 bytes of the deduped slice descriptors — not the fact payloads, which this layer does not materialize. */
  readonly serializedInputBytes: number;
  readonly tokenEstimate: number;
  readonly tokenEstimatorVersion: string;
  readonly sliceContractVersion: string;
  readonly dependencyWaves: number;
  readonly concurrencyCap: number;
  readonly retryCap: number;
}

export interface PreviewOptions {
  readonly concurrencyCap: number;
  readonly retryCap: number;
}

/**
 * A machine-readable preview of what a plan will do, before any model runs:
 * how many blocks, bundles and unique slices, how many slices are shared, the
 * serialized input size and its versioned token estimate, the dependency-wave
 * count and the concurrency and retry ceilings. Deterministic over the plan and
 * its materialized slices.
 */
export function previewPlan(
  plan: ReportPlan,
  slices: MaterializedSlices,
  options: PreviewOptions,
): PlanPreview {
  const blocks: BlockPlan[] = plan.documents.flatMap((d) => d.sections.flatMap((s) => [...s.blocks]));
  const authoredBlockCount = blocks.filter((b) => b.task !== undefined).length;
  const serializedInputBytes = slices.slices.reduce(
    (sum, s) => sum + Buffer.byteLength(stableStringify(s), "utf8"),
    0,
  );
  const waves = new Set(plan.documents.flatMap((d) => d.sections.map((s) => s.wave)));
  const sharedSliceCount = Object.values(slices.refCounts).filter((n) => n > 1).length;

  return {
    blockCount: blocks.length,
    authoredBlockCount,
    bundleCount: plan.bundles.length,
    sliceCount: slices.slices.length,
    sharedSliceCount,
    serializedInputBytes,
    tokenEstimate: estimateTokens(serializedInputBytes),
    tokenEstimatorVersion: TOKEN_ESTIMATOR_VERSION,
    sliceContractVersion: slices.sliceContractVersion,
    dependencyWaves: waves.size,
    concurrencyCap: options.concurrencyCap,
    retryCap: options.retryCap,
  };
}

/**
 * A single auditable identity over a plan and its materialized slices: the plan's
 * run identity (via its digest) folded with the slice-contract version and every
 * slice key. Bumping the slice-query contract moves this digest even though it
 * does not move the plan's own digest, so the slice version is in the audit trail.
 */
export function planSliceAuditDigest(plan: ReportPlan, slices: MaterializedSlices): string {
  return digest({
    planDigest: plan.planDigest,
    sliceContractVersion: slices.sliceContractVersion,
    sliceKeys: slices.slices.map((s) => s.sliceKey),
  });
}

// ---------------------------------------------------------------------------
// The bundle-execution boundary — a Host Agent produces one result per block.
// ---------------------------------------------------------------------------

export interface BlockResult {
  readonly blockId: string;
  readonly taskId: string;
  readonly ok: boolean;
  readonly artifactRef: string | null;
  /** Set when ok is false — always one of the closed failure kinds. */
  readonly failure: BlockFailureKind | null;
}

/**
 * The task ids a bundle carries, in order. A bundle keeps each block's task
 * distinct, so a host produces one separately-keyed result per block.
 */
export function bundleTaskIds(bundle: ExecutionBundle): readonly string[] {
  return bundle.taskIds;
}
