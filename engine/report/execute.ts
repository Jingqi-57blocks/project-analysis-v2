/**
 * The execution orchestrator: the seam between a compiled plan (PI-14/80) and the
 * assembler (PI-18). It drives the external Host Agent over a plan's authored
 * tasks, retries a failed task alone within the policy budget, and collects the
 * validated per-block artifacts the assembler consumes — the engine crosses the
 * Host Agent seam here and nowhere else.
 *
 * It calls no model itself: a `HostAgent` (fake in a test, real in production)
 * satisfies the seam identically, so this loop is deterministic given a
 * deterministic host. It counts what it did — Host Agent tasks, attempts, retries
 * and deterministic renders — so a caller (PI-73) can prove a multi-document
 * request runs each authored task once and never re-executes shared work.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import {
  type HostAgent,
  type ReportPlan,
  type TaskLedger,
  adoptedAttempt,
  authoredTasks,
  emptyLedger,
  recordAttempt,
} from "../contracts/report/pipeline.js";
import {
  type AssemblyResult,
  type BlockArtifact,
  type PolicyLimits,
  STANDARD_V1_LIMITS,
  assembleValidatedBlocks,
} from "./bundle.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** What the orchestrator did — the accounting a dedup audit checks against the plan. */
export interface ExecutionCounters {
  /** Distinct authored tasks executed — one per authored-required block, never more. */
  readonly hostAgentTasks: number;
  /** Total Host Agent calls, including retries. */
  readonly hostAgentAttempts: number;
  /** Retries beyond each task's first attempt. */
  readonly retries: number;
  /** Deterministic blocks rendered from the fact base — no Host Agent call. */
  readonly deterministicRenders: number;
}

export interface ExecutionRun {
  /** One ledger per authored task, in the plan's task order — the full attempt trail. */
  readonly ledgers: readonly TaskLedger[];
  /** The per-block artifacts, validated or not, the assembler consumes. */
  readonly artifacts: readonly BlockArtifact[];
  /** Completeness over the required authored blocks — fail-closed when one never validated. */
  readonly assembly: AssemblyResult;
  readonly counters: ExecutionCounters;
  /** Stable over the whole run's adopted outcomes and counts — the same host gives the same digest. */
  readonly executionDigest: string;
}

/**
 * Run every authored task in the plan through the Host Agent, retrying a task that
 * fails validation alone while it has budget (attempts up to `maxRetries + 1`),
 * and stopping as soon as an attempt is accepted and validates. A task's passed
 * siblings are never re-run — each task retries on its own ledger. The produced
 * artifacts are then assembled: any required authored block with no validated
 * artifact leaves the run incomplete.
 *
 * Deterministic given a deterministic host: the task order is the plan's, and the
 * retry decision is a pure function of the host's reported outcome.
 */
export function executeAuthoredTasks(
  plan: ReportPlan,
  host: HostAgent,
  limits: PolicyLimits = STANDARD_V1_LIMITS,
): ExecutionRun {
  const tasks = authoredTasks(plan);
  const ledgers: TaskLedger[] = [];
  let hostAgentAttempts = 0;
  let retries = 0;

  for (const task of tasks) {
    let ledger = emptyLedger(task.taskId);
    for (let attempt = 0; attempt < limits.maxRetries + 1; attempt += 1) {
      const outcome = host.execute(task);
      ledger = recordAttempt(ledger, { ...outcome, taskId: task.taskId });
      hostAgentAttempts += 1;
      if (attempt > 0) retries += 1;
      // Stop at the first adoptable attempt — accepted and validated.
      if (outcome.outcome === "accepted" && outcome.validationOk) break;
    }
    ledgers.push(ledger);
  }

  const artifacts: readonly BlockArtifact[] = tasks.map((task, i) => {
    const adopted = adoptedAttempt(ledgers[i]!);
    return {
      blockId: task.blockId,
      taskId: task.taskId,
      validated: adopted !== null,
      artifactRef: adopted?.artifactRef ?? null,
    };
  });

  const assembly = assembleValidatedBlocks(plan, artifacts);
  const deterministicRenders = plan.documents
    .flatMap((d) => d.sections.flatMap((s) => s.blocks))
    .filter((b) => b.task === undefined).length;

  const counters: ExecutionCounters = {
    hostAgentTasks: tasks.length,
    hostAgentAttempts,
    retries,
    deterministicRenders,
  };

  const executionDigest = digest({
    adopted: ledgers.map((l) => ({ taskId: l.taskId, artifactRef: adoptedAttempt(l)?.artifactRef ?? null })),
    counters,
    complete: assembly.complete,
    missingRequired: assembly.missingRequired,
  });

  return { ledgers, artifacts, assembly, counters, executionDigest };
}
