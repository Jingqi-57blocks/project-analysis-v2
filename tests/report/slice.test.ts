import { describe, expect, it } from "vitest";

import {
  type GenerationParams,
  authoredTasks,
  compileReportPlan,
} from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { projectTarget } from "../../engine/contracts/report/target.js";
import {
  type BlockResult,
  type SliceCompileContext,
  BLOCK_FAILURE_KINDS,
  EMPTY_OVERLAY,
  applyOverlay,
  compileBoundedSlice,
  materializeSlices,
  planSliceAuditDigest,
  previewPlan,
  validateFactAgainstSlice,
} from "../../engine/report/slice.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "src-1",
  codeGraphIdentity: "graph-1",
  providerIdentity: "providers-1",
  schemaVersion: "1.0.0",
  configIdentity: "config-1",
};

const PARAMS: GenerationParams = { executorKind: "host-agent", modelId: "claude-opus-4-8", language: "en" };
const CTX: SliceCompileContext = { analysisRunId: "run-1", schemaVersion: "1.0.0" };

function plan(request = [projectTarget("product"), projectTarget("developer")]) {
  return compileReportPlan({ request, snapshot: SNAPSHOT, params: PARAMS });
}

describe("compileBoundedSlice — determinism and identity", () => {
  it("is byte-stable for the same context, scope and kinds", () => {
    const a = compileBoundedSlice(CTX, { kind: "project" }, ["condition", "route"]);
    const b = compileBoundedSlice(CTX, { kind: "project" }, ["route", "condition"]);
    expect(a.sliceKey).toBe(b.sliceKey); // kind order does not matter
    expect(a.sliceDigest).toBe(b.sliceDigest);
  });

  it("folds the analysis run and schema version into the key", () => {
    const base = compileBoundedSlice(CTX, { kind: "project" }, ["condition"]);
    const otherRun = compileBoundedSlice({ ...CTX, analysisRunId: "run-2" }, { kind: "project" }, ["condition"]);
    const otherSchema = compileBoundedSlice({ ...CTX, schemaVersion: "2.0.0" }, { kind: "project" }, ["condition"]);
    expect(otherRun.sliceKey).not.toBe(base.sliceKey);
    expect(otherSchema.sliceKey).not.toBe(base.sliceKey);
  });

  it("distinguishes scope, depth and count cap", () => {
    const project = compileBoundedSlice(CTX, { kind: "project" }, ["condition"]);
    const module = compileBoundedSlice(CTX, { kind: "module", moduleId: "leave" }, ["condition"]);
    const deeper = compileBoundedSlice(CTX, { kind: "project" }, ["condition"], { relationshipDepth: 3 });
    const capped = compileBoundedSlice(CTX, { kind: "project" }, ["condition"], { countCap: 10 });
    expect(project.sliceKey).not.toBe(module.sliceKey);
    expect(deeper.sliceKey).not.toBe(project.sliceKey);
    expect(capped.sliceKey).not.toBe(project.sliceKey);
  });
});

describe("materializeSlices — cross-document dedup", () => {
  it("materializes each slice key once and counts its readers", () => {
    const materialized = materializeSlices(plan(), CTX);
    // one slice per key, ordered
    const keys = materialized.slices.map((s) => s.sliceKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort());
    // every reference resolves to a materialized slice
    for (const ref of materialized.references) {
      expect(keys).toContain(ref.sliceKey);
    }
    // the shared identity section reads the same slice in both documents → shared
    expect(Object.values(materialized.refCounts).some((n) => n > 1)).toBe(true);
  });

  it("is deterministic — same plan and context give the same table", () => {
    const a = materializeSlices(plan(), CTX);
    const b = materializeSlices(plan(), CTX);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not carry facts twice: a slice shared by N blocks is one entry with refCount N", () => {
    const materialized = materializeSlices(plan(), CTX);
    const total = Object.values(materialized.refCounts).reduce((a, b) => a + b, 0);
    // references count every block; slices count unique keys — fewer when shared
    expect(total).toBe(materialized.references.length);
    expect(materialized.slices.length).toBeLessThanOrEqual(materialized.references.length);
  });

  it("keeps prerequisites on the per-block reference, off the shared slice", () => {
    const p = plan(); // the shared `identity` section appears in both documents
    const withPrereq = materializeSlices(p, CTX, { identity: { prerequisiteSections: ["foundations"] } });
    const withoutPrereq = materializeSlices(p, CTX, {});

    // prerequisites are not slice identity: the slice set and keys are unchanged
    expect(withPrereq.slices.map((s) => s.sliceKey)).toEqual(withoutPrereq.slices.map((s) => s.sliceKey));
    // no BoundedFactSlice carries prerequisites — they cannot be dropped on dedup
    for (const s of withPrereq.slices) expect("prerequisiteSections" in s).toBe(false);
    // every reference to the gated section carries its prerequisite, in both documents
    const identityRefs = withPrereq.references.filter((r) => r.sectionId === "identity");
    expect(identityRefs.length).toBeGreaterThan(1);
    for (const r of identityRefs) expect(r.prerequisiteSections).toEqual(["foundations"]);
    // and the identity slice is still materialized exactly once
    const key = identityRefs[0]!.sliceKey;
    expect(withPrereq.slices.filter((s) => s.sliceKey === key)).toHaveLength(1);
  });

  it("folds the slice contract version and slice keys into an audit digest", () => {
    const p = plan();
    const m = materializeSlices(p, CTX);
    expect(m.sliceContractVersion).toBe("1.0.0");
    expect(planSliceAuditDigest(p, m)).toBe(planSliceAuditDigest(p, m)); // deterministic
    // a different analysis run yields different slice keys → a different audit digest
    const m2 = materializeSlices(p, { ...CTX, analysisRunId: "run-2" });
    expect(planSliceAuditDigest(p, m2)).not.toBe(planSliceAuditDigest(p, m));
  });
});

describe("validateFactAgainstSlice — the boundary is enforced", () => {
  const slice = compileBoundedSlice(CTX, { kind: "project" }, ["condition", "route"], { relationshipDepth: 2 });

  it("accepts a declared kind within the depth ceiling", () => {
    expect(validateFactAgainstSlice(slice, { factId: "f1", kind: "condition", depth: 1 })).toEqual({ ok: true });
  });

  it("rejects an undeclared kind", () => {
    const r = validateFactAgainstSlice(slice, { factId: "f1", kind: "entity", depth: 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violation).toBe("undeclared-kind");
  });

  it("rejects a fact past the relationship-depth ceiling", () => {
    const r = validateFactAgainstSlice(slice, { factId: "f1", kind: "condition", depth: 3 });
    expect(r.ok === false && r.violation).toBe("depth-exceeded");
  });

  it("rejects a fact outside the materialized id set when one is given", () => {
    const r = validateFactAgainstSlice(slice, { factId: "f9", kind: "condition", depth: 1 }, new Set(["f1", "f2"]));
    expect(r.ok === false && r.violation).toBe("out-of-slice");
  });

  it("lets a `*` ledger slice admit any kind but still enforces depth and the id set", () => {
    const star = compileBoundedSlice(CTX, { kind: "project" }, ["*"], { relationshipDepth: 1 });
    expect(validateFactAgainstSlice(star, { factId: "f1", kind: "anything", depth: 1 })).toEqual({ ok: true });
    expect(validateFactAgainstSlice(star, { factId: "f1", kind: "anything", depth: 2 }).ok).toBe(false);
    // a `*` slice still rejects a fact outside the materialized id set
    const r = validateFactAgainstSlice(star, { factId: "f9", kind: "anything", depth: 1 }, new Set(["f1"]));
    expect(r.ok === false && r.violation).toBe("out-of-slice");
  });
});

describe("applyOverlay — the seam, without a rule language", () => {
  const ids = ["a", "b", "c"];

  it("is a no-op for the empty overlay", () => {
    expect(applyOverlay(ids, EMPTY_OVERLAY)).toEqual(ids);
  });

  it("includes, excludes, replaces and reorders deterministically", () => {
    expect(applyOverlay(ids, { ops: [{ op: "include", sectionId: "d" }] })).toEqual(["a", "b", "c", "d"]);
    expect(applyOverlay(ids, { ops: [{ op: "include", sectionId: "b" }] })).toEqual(ids); // no duplicate
    expect(applyOverlay(ids, { ops: [{ op: "exclude", sectionId: "b" }] })).toEqual(["a", "c"]);
    expect(applyOverlay(ids, { ops: [{ op: "replace", sectionId: "b", withSectionId: "x" }] })).toEqual(["a", "x", "c"]);
    expect(applyOverlay(ids, { ops: [{ op: "reorder", order: ["c", "a"] }] })).toEqual(["c", "a", "b"]);
  });

  it("applies ops in order", () => {
    const out = applyOverlay(ids, {
      ops: [
        { op: "exclude", sectionId: "a" },
        { op: "include", sectionId: "z" },
        { op: "reorder", order: ["z"] },
      ],
    });
    expect(out).toEqual(["z", "b", "c"]);
  });

  it("never duplicates a section id — repeated reorder or colliding replace", () => {
    // a repeated id in the requested order must not duplicate the section
    expect(applyOverlay(ids, { ops: [{ op: "reorder", order: ["c", "c", "a"] }] })).toEqual(["c", "a", "b"]);
    // replacing onto an id that already exists drops the source rather than twinning it
    expect(applyOverlay(ids, { ops: [{ op: "replace", sectionId: "a", withSectionId: "b" }] })).toEqual(["b", "c"]);
  });
});

describe("previewPlan — inspectable before it runs", () => {
  it("reports blocks, bundles, unique and shared slices, bytes, token estimate and caps", () => {
    const p = plan();
    const materialized = materializeSlices(p, CTX);
    const preview = previewPlan(p, materialized, { concurrencyCap: 4, retryCap: 2 });

    expect(preview.blockCount).toBeGreaterThan(0);
    expect(preview.bundleCount).toBe(p.bundles.length);
    expect(preview.sliceCount).toBe(materialized.slices.length);
    expect(preview.sharedSliceCount).toBeGreaterThan(0);
    expect(preview.serializedInputBytes).toBeGreaterThan(0);
    expect(preview.tokenEstimate).toBe(Math.ceil(preview.serializedInputBytes / 4));
    expect(preview.tokenEstimatorVersion).toBe("token-estimate-v1");
    expect(preview.sliceContractVersion).toBe(materialized.sliceContractVersion);
    expect(preview.concurrencyCap).toBe(4);
    expect(preview.retryCap).toBe(2);
  });

  it("is deterministic", () => {
    const p = plan();
    const m = materializeSlices(p, CTX);
    expect(previewPlan(p, m, { concurrencyCap: 4, retryCap: 2 })).toEqual(
      previewPlan(p, m, { concurrencyCap: 4, retryCap: 2 }),
    );
  });
});

describe("bundle execution boundary — a fake Host Agent from the bundle alone", () => {
  // The fake host reads only the bundle's tasks (their declared slice) — never a
  // repository or chat history — and returns one structurally-valid result per
  // block, separated by block ID.
  function fakeHost(taskIds: readonly string[], tasksById: Map<string, { blockId: string }>): BlockResult[] {
    return taskIds.map((taskId, i) => {
      const blockId = tasksById.get(taskId)!.blockId;
      const failing = i === 0; // exercise one failure path
      return failing
        ? { blockId, taskId, ok: false, artifactRef: null, failure: "validation-failed" as const }
        : { blockId, taskId, ok: true, artifactRef: `artifact/${blockId}`, failure: null };
    });
  }

  it("produces one block-ID-separated result per task in the bundle", () => {
    const p = plan([projectTarget("product")]);
    const tasksById = new Map(authoredTasks(p).map((t) => [t.taskId, { blockId: t.blockId }]));
    const bundle = p.bundles[0]!;

    const results = fakeHost(bundle.taskIds, tasksById);

    expect(results).toHaveLength(bundle.taskIds.length);
    // every result is separated by a distinct block id and carries a valid outcome
    expect(new Set(results.map((r) => r.blockId)).size).toBe(results.length);
    for (const r of results) {
      if (r.ok) {
        expect(r.failure).toBeNull();
        expect(r.artifactRef).not.toBeNull();
      } else {
        expect(r.failure).not.toBeNull();
        expect(BLOCK_FAILURE_KINDS).toContain(r.failure);
      }
    }
  });
});
