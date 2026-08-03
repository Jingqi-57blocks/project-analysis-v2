import { describe, expect, it } from "vitest";

import type { GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { projectTarget } from "../../engine/contracts/report/target.js";
import { authoredTasks } from "../../engine/contracts/report/pipeline.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { executeAuthoredTasks } from "../../engine/report/execute.js";
import { fakeHost } from "./helpers/fake-host.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "src-1",
  codeGraphIdentity: "graph-1",
  providerIdentity: "providers-1",
  schemaVersion: "1.0.0",
  configIdentity: "config-1",
};
const PARAMS: GenerationParams = { executorKind: "host-agent", modelId: "claude-opus-4-8", language: "en" };

function plan(request = [projectTarget("developer")]) {
  return compileExecutablePlan({ request, snapshot: SNAPSHOT, params: PARAMS, analysisRunId: "run-1" }).plan;
}

describe("executeAuthoredTasks — one Host Agent call per task when all pass", () => {
  it("runs every authored task exactly once and completes the run", () => {
    const p = plan();
    const tasks = authoredTasks(p);
    expect(tasks.length).toBeGreaterThan(0);

    const host = fakeHost();
    const run = executeAuthoredTasks(p, host);

    expect(run.counters.hostAgentTasks).toBe(tasks.length);
    expect(run.counters.hostAgentAttempts).toBe(tasks.length); // no retries
    expect(run.counters.retries).toBe(0);
    for (const t of tasks) expect(host.callCount(t.taskId)).toBe(1); // never re-executed
    expect(run.assembly.complete).toBe(true);
    expect(run.assembly.missingRequired).toEqual([]);
    expect(Object.keys(run.assembly.artifactByTask).length).toBe(tasks.length);
  });
});

describe("executeAuthoredTasks — a failed task retries alone within budget", () => {
  it("retries the flaky task and adopts its later validated attempt", () => {
    const p = plan();
    const target = authoredTasks(p)[0]!;
    const host = fakeHost({ flakyUntil: { [target.taskId]: 1 } }); // fails once, then succeeds

    const run = executeAuthoredTasks(p, host);

    expect(host.callCount(target.taskId)).toBe(2); // one retry
    expect(run.counters.retries).toBe(1);
    expect(run.assembly.complete).toBe(true); // adopted on attempt 2
    // siblings still ran once each
    for (const t of authoredTasks(p).slice(1)) expect(host.callCount(t.taskId)).toBe(1);
  });
});

describe("executeAuthoredTasks — a required block that never validates blocks completion", () => {
  it("leaves the run incomplete and names the missing task, without exceeding the retry budget", () => {
    const p = plan();
    const target = authoredTasks(p)[0]!;
    const host = fakeHost({ alwaysReject: new Set([target.taskId]) });

    const run = executeAuthoredTasks(p, host);

    expect(run.assembly.complete).toBe(false);
    expect(run.assembly.missingRequired).toContain(target.taskId);
    expect(host.callCount(target.taskId)).toBe(3); // maxRetries (2) + 1, then exhausted
  });

  it("treats an executor error the same as a missing required block", () => {
    const p = plan();
    const target = authoredTasks(p)[0]!;
    const run = executeAuthoredTasks(p, fakeHost({ alwaysError: new Set([target.taskId]) }));
    expect(run.assembly.complete).toBe(false);
    expect(run.assembly.missingRequired).toContain(target.taskId);
  });
});

describe("executeAuthoredTasks — deterministic given a deterministic host", () => {
  it("gives the same execution digest for the same plan and host config", () => {
    const p = plan();
    const a = executeAuthoredTasks(p, fakeHost());
    const b = executeAuthoredTasks(p, fakeHost());
    expect(a.executionDigest).toBe(b.executionDigest);
  });

  it("moves the digest when an outcome changes", () => {
    const p = plan();
    const target = authoredTasks(p)[0]!;
    const clean = executeAuthoredTasks(p, fakeHost());
    const flaky = executeAuthoredTasks(p, fakeHost({ flakyUntil: { [target.taskId]: 1 } }));
    // adopted refs are the same (final artifact://taskId), but the counters differ
    expect(flaky.counters.retries).not.toBe(clean.counters.retries);
    expect(flaky.executionDigest).not.toBe(clean.executionDigest);
  });
});
