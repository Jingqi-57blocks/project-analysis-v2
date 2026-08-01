/**
 * A deterministic fake Host Agent for the report execution contract tests. It
 * satisfies the same seam a real host does, and records its calls so a test can
 * prove each authored task ran the expected number of times. Configurable to fail
 * a task a fixed number of times (flaky, then succeeds), always reject it
 * (validation never passes), or error it (produces no artifact) — the three
 * scenarios PI-73 requires: a bundle returning many blocks, a single block
 * retried alone, and a required block that never validates.
 */

import type { AttemptReceipt, AuthoredBlockTask, HostAgent } from "../../../engine/contracts/report/pipeline.js";

export interface FakeHostConfig {
  /** taskId → number of leading attempts that fail validation before one succeeds. */
  readonly flakyUntil?: Readonly<Record<string, number>>;
  /** taskIds whose every attempt rejects (validation never passes). */
  readonly alwaysReject?: ReadonlySet<string>;
  /** taskIds whose every attempt errors (no artifact produced). */
  readonly alwaysError?: ReadonlySet<string>;
}

export interface RecordingHost extends HostAgent {
  /** taskIds in call order — a duplicate here is a duplicate execution. */
  readonly calls: readonly string[];
  callCount(taskId: string): number;
}

export function fakeHost(config: FakeHostConfig = {}): RecordingHost {
  const calls: string[] = [];
  const attempts = new Map<string, number>();

  return {
    calls,
    callCount: (taskId) => calls.filter((t) => t === taskId).length,
    execute(task: AuthoredBlockTask): Omit<AttemptReceipt, "attempt" | "taskId"> {
      calls.push(task.taskId);
      const n = (attempts.get(task.taskId) ?? 0) + 1;
      attempts.set(task.taskId, n);
      const base = { executorKind: task.identity.executorKind, modelId: task.identity.modelId };

      if (config.alwaysError?.has(task.taskId)) {
        return { ...base, outcome: "failed", artifactRef: null, validationOk: false, detail: "executor error" };
      }
      if (config.alwaysReject?.has(task.taskId)) {
        return { ...base, outcome: "rejected", artifactRef: `artifact://${task.taskId}#${n}`, validationOk: false, detail: "validation failed" };
      }
      const failFor = config.flakyUntil?.[task.taskId] ?? 0;
      if (n <= failFor) {
        return { ...base, outcome: "rejected", artifactRef: `artifact://${task.taskId}#${n}`, validationOk: false, detail: `flaky attempt ${n}` };
      }
      return { ...base, outcome: "accepted", artifactRef: `artifact://${task.taskId}`, validationOk: true, detail: "ok" };
    },
  };
}
