/**
 * Executor selection for the report command.
 *
 * The authoring port is model-agnostic (a runner can be injected); this maps the
 * `--executor` choice to the identity label recorded in the run and the runner to
 * inject. `codex` keeps the port's built-in Codex CLI default (no injected
 * runner); `claude-code` routes every authoring call through the `claude` CLI.
 */

import { claudeCodeRunner } from "../host/claude-code-agent.js";
import type { JsonAgentRequest } from "../host/json-agent.js";

export const EXECUTORS = ["codex", "claude-code"] as const;
export type ExecutorId = (typeof EXECUTORS)[number];

/** A runner usable for any authoring response type (classifier, batch, repairs). */
export type GenericJsonAgentRunner = <T>(request: Omit<JsonAgentRequest<T>, "run">) => Promise<T>;

export interface ResolvedExecutor {
  readonly id: ExecutorId;
  /** The identity label recorded in the run and the authoring cache key. */
  readonly executorKind: string;
  /** The runner to inject, or undefined to use the port's default (Codex CLI). */
  readonly run: GenericJsonAgentRunner | undefined;
}

export function isExecutorId(value: string): value is ExecutorId {
  return (EXECUTORS as readonly string[]).includes(value);
}

export function resolveExecutor(id: ExecutorId): ResolvedExecutor {
  switch (id) {
    case "claude-code":
      return { id, executorKind: "claude-code", run: claudeCodeRunner };
    case "codex":
      return { id, executorKind: "codex-cli", run: undefined };
  }
}
