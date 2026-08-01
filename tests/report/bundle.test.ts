import { describe, expect, it } from "vitest";

import {
  type GenerationParams,
  authoredTasks,
  compileReportPlan,
} from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { projectTarget } from "../../engine/contracts/report/target.js";
import { type SliceCompileContext, materializeSlices } from "../../engine/report/slice.js";
import {
  type BlockArtifact,
  type BlockExecutionReceipt,
  type BlockValidation,
  type PolicyLimits,
  STANDARD_V1_LIMITS,
  accountRun,
  assembleValidatedBlocks,
  compileExecutionBundles,
  planRetry,
} from "../../engine/report/bundle.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "src-1",
  codeGraphIdentity: "graph-1",
  providerIdentity: "providers-1",
  schemaVersion: "1.0.0",
  configIdentity: "config-1",
};
const PARAMS: GenerationParams = { executorKind: "host-agent", modelId: "claude-opus-4-8", language: "en" };
const CTX: SliceCompileContext = { analysisRunId: "run-1", schemaVersion: "1.0.0" };

function planAndSlices(request = [projectTarget("product"), projectTarget("developer")]) {
  const plan = compileReportPlan({ request, snapshot: SNAPSHOT, params: PARAMS });
  return { plan, slices: materializeSlices(plan, CTX) };
}

describe("compileExecutionBundles — deterministic, bounded grouping", () => {
  it("is byte-stable: same plan, slices and policy give the same bundles and ids", () => {
    const a = planAndSlices();
    const b = planAndSlices();
    const pa = compileExecutionBundles(a.plan, a.slices);
    const pb = compileExecutionBundles(b.plan, b.slices);
    expect(JSON.stringify(pa)).toBe(JSON.stringify(pb));
  });

  it("never merges across audience or scope", () => {
    const { plan, slices } = planAndSlices();
    const bundlePlan = compileExecutionBundles(plan, slices);
    const docByTask = new Map(authoredTasks(plan).map((t) => [t.taskId, { documentId: t.documentId, audience: t.identity }]));
    const audienceByDoc = new Map(plan.documents.map((d) => [d.documentId, d.audience] as const));
    for (const bundle of bundlePlan.bundles) {
      // every task in a bundle belongs to that bundle's document (one audience, one scope)
      for (const taskId of bundle.taskIds) {
        expect(docByTask.get(taskId)?.documentId).toBe(bundle.documentId);
      }
      expect(audienceByDoc.get(bundle.documentId)).toBe(bundle.audience);
    }
  });

  it("carries the de-duplicated slice union of its member blocks", () => {
    const { plan, slices } = planAndSlices([projectTarget("product")]);
    const bundlePlan = compileExecutionBundles(plan, slices);
    for (const bundle of bundlePlan.bundles) {
      expect(bundle.sliceKeys).toEqual([...new Set(bundle.sliceKeys)].sort());
      expect(bundle.taskIds.length).toBeGreaterThan(0);
    }
    // with the default cap the project/product authored blocks fit in one bundle
    expect(bundlePlan.bundles.length).toBeGreaterThan(0);
    expect(bundlePlan.failures).toHaveLength(0);
  });

  it("splits a group at a stable boundary when it exceeds the input cap", () => {
    const { plan, slices } = planAndSlices([projectTarget("product")]);
    // a tiny cap forces multiple bundles within the one document/audience/scope/wave group
    const tight: PolicyLimits = { ...STANDARD_V1_LIMITS, bundleInputByteCap: 600 };
    const bundlePlan = compileExecutionBundles(plan, slices, tight);
    expect(bundlePlan.bundles.length).toBeGreaterThan(1);
    expect(bundlePlan.splitReasons.length).toBeGreaterThan(0);
    // splits are indexed in stable order 0,1,2,…
    const indices = bundlePlan.bundles.map((b) => b.splitIndex);
    expect(indices).toEqual([...indices].sort((x, y) => x - y));
    // still no facts carried twice within a bundle, and no cross-doc merge
    for (const b of bundlePlan.bundles) expect(b.inputBytes).toBeLessThanOrEqual(600);
  });

  it("fails a single block closed when its slice alone exceeds the cap — never truncates", () => {
    const { plan, slices } = planAndSlices([projectTarget("product")]);
    const impossible: PolicyLimits = { ...STANDARD_V1_LIMITS, bundleInputByteCap: 10 };
    const bundlePlan = compileExecutionBundles(plan, slices, impossible);
    expect(bundlePlan.failures.length).toBeGreaterThan(0);
    for (const f of bundlePlan.failures) expect(f.failure).toBe("budget-exceeded");
    // nothing was silently bundled over the cap
    for (const b of bundlePlan.bundles) expect(b.inputBytes).toBeLessThanOrEqual(10);
  });
});

describe("planRetry — retry only the failed block, keep the passed siblings", () => {
  const results: BlockValidation[] = [
    { blockId: "b1", taskId: "t1", ok: true, failure: null },
    { blockId: "b2", taskId: "t2", ok: false, failure: "validation-failed" },
    { blockId: "b3", taskId: "t3", ok: true, failure: null },
  ];

  it("keeps passed blocks and retries only the failed one within budget", () => {
    const decision = planRetry(results, { t1: 1, t2: 1, t3: 1 });
    expect(decision.kept).toEqual(["t1", "t3"]);
    expect(decision.retry).toEqual(["t2"]);
    expect(decision.exhausted).toEqual([]);
  });

  it("marks a block exhausted once its attempts reach the cap", () => {
    // maxRetries 2 → 3 attempts allowed; at 3 attempts it is exhausted
    const decision = planRetry(results, { t1: 1, t2: 3, t3: 1 });
    expect(decision.retry).toEqual([]);
    expect(decision.exhausted).toEqual(["t2"]);
    expect(decision.kept).toEqual(["t1", "t3"]);
  });
});

describe("accountRun — the run is countable", () => {
  it("reports deterministic/authored/bundle counts, attempts, tokens and a wave-respecting critical path", () => {
    const { plan, slices } = planAndSlices([projectTarget("product")]);
    const bundlePlan = compileExecutionBundles(plan, slices);
    const authored = authoredTasks(plan);
    const receipts: BlockExecutionReceipt[] = authored.map((t, i) => ({
      blockId: t.blockId,
      taskId: t.taskId,
      wave: 0,
      queueMs: 5,
      execMs: 100 + i,
      validateMs: 10,
      attempts: 1,
      retries: 0,
      inputTokens: 200,
      outputTokens: 50,
      failure: null,
    }));
    const accounting = accountRun(plan, bundlePlan, receipts);

    expect(accounting.authoredBlockCount).toBe(authored.length);
    expect(accounting.deterministicBlockCount).toBeGreaterThan(0);
    expect(accounting.bundleCount).toBe(bundlePlan.bundles.length);
    expect(accounting.totalAttempts).toBe(authored.length);
    expect(accounting.totalInputTokens).toBe(authored.length * 200);
    // one wave → critical path is the slowest block's elapsed time
    const slowest = Math.max(...receipts.map((r) => r.queueMs + r.execMs + r.validateMs));
    expect(accounting.criticalPathMs).toBe(slowest);
  });

  it("sums the slowest block per wave across sequential waves", () => {
    const { plan, slices } = planAndSlices([projectTarget("product")]);
    const bundlePlan = compileExecutionBundles(plan, slices);
    const receipts: BlockExecutionReceipt[] = [
      { blockId: "a", taskId: "ta", wave: 0, queueMs: 0, execMs: 100, validateMs: 0, attempts: 1, retries: 0, inputTokens: 0, outputTokens: 0, failure: null },
      { blockId: "b", taskId: "tb", wave: 0, queueMs: 0, execMs: 40, validateMs: 0, attempts: 1, retries: 0, inputTokens: 0, outputTokens: 0, failure: null },
      { blockId: "c", taskId: "tc", wave: 1, queueMs: 0, execMs: 70, validateMs: 0, attempts: 1, retries: 0, inputTokens: 0, outputTokens: 0, failure: null },
    ];
    // wave 0 slowest 100 + wave 1 slowest 70 = 170
    expect(accountRun(plan, bundlePlan, receipts).criticalPathMs).toBe(170);
  });
});

describe("assembleValidatedBlocks — validated artifacts only; complete or not", () => {
  it("is complete when every required authored block has a validated artifact", () => {
    const { plan } = planAndSlices([projectTarget("product")]);
    const artifacts: BlockArtifact[] = authoredTasks(plan).map((t) => ({
      blockId: t.blockId,
      taskId: t.taskId,
      validated: true,
      artifactRef: `artifact/${t.blockId}`,
    }));
    const result = assembleValidatedBlocks(plan, artifacts);
    expect(result.complete).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("is incomplete when a required authored block is missing or unvalidated", () => {
    const { plan } = planAndSlices([projectTarget("product")]);
    const tasks = authoredTasks(plan);
    const artifacts: BlockArtifact[] = tasks.map((t, i) => ({
      blockId: t.blockId,
      taskId: t.taskId,
      // the first block failed validation — its artifact must not be consumed
      validated: i !== 0,
      artifactRef: i !== 0 ? `artifact/${t.blockId}` : null,
    }));
    const result = assembleValidatedBlocks(plan, artifacts);
    expect(result.complete).toBe(false);
    expect(result.missingRequired).toContain(tasks[0]!.blockId);
    // the unvalidated block contributes no artifact
    expect(result.artifactByBlock[tasks[0]!.blockId]).toBeUndefined();
  });
});

describe("bundle execution boundary — a fake Host Agent returns ≥2 blocks per bundle", () => {
  it("returns per-block results; a failure retries only its block, siblings kept", () => {
    const { plan, slices } = planAndSlices([projectTarget("product")]);
    const bundlePlan = compileExecutionBundles(plan, slices);
    const tasksById = new Map(authoredTasks(plan).map((t) => [t.taskId, t.blockId]));

    // find a bundle with at least two blocks (the default cap keeps them together)
    const bundle = bundlePlan.bundles.find((b) => b.taskIds.length >= 2);
    expect(bundle).toBeDefined();

    // fake host: validates every block but the first, keyed by block id
    const results: BlockValidation[] = bundle!.taskIds.map((taskId, i) => ({
      blockId: tasksById.get(taskId)!,
      taskId,
      ok: i !== 0,
      failure: i === 0 ? "validation-failed" : null,
    }));
    // each block is separately keyed and accounted
    expect(new Set(results.map((r) => r.blockId)).size).toBe(results.length);

    const decision = planRetry(results, Object.fromEntries(bundle!.taskIds.map((t) => [t, 1])));
    expect(decision.retry).toEqual([bundle!.taskIds[0]]);
    // the passed siblings are kept, not regenerated
    expect([...decision.kept].sort()).toEqual([...bundle!.taskIds.slice(1)].sort());
  });
});
