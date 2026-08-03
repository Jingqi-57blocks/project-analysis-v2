/**
 * A Claude Code adapter for the model-agnostic JSON authoring port.
 *
 * It satisfies the same {@link JsonAgentRunner} seam the Codex adapter does, so
 * the classifier, the batch author and its repair passes can be routed to the
 * `claude` CLI without any engine change. The command runs in `--print` mode in
 * an empty temporary working directory, receives the prompt on stdin and the
 * output schema inline, and returns the one schema-validated JSON value Claude's
 * structured output produces; it is never asked to inspect the analyzed source.
 *
 * The command streams its progress (`--output-format stream-json`), which is
 * used as a liveness signal: authoring a whole module is one long call, so a
 * fixed wall-clock cap can only be an arbitrary cliff a large enough module
 * would still hit. Instead the run is killed only after a stretch of *silence* —
 * distinguishing a slow-but-working call from a genuinely hung one, whatever the
 * module's size.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonAgentError, type JsonAgentRequest } from "./json-agent.js";

/** The terminating result envelope `claude` prints as the last stream-json event. */
interface ClaudeResultEnvelope {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly api_error_status?: string | null;
  readonly result?: string;
  readonly structured_output?: unknown;
}

const MAX_STDERR_BYTES = 200_000;
/** A single stream-json line larger than this without a newline is treated as runaway. */
const MAX_LINE_BYTES = 33_554_432;
/**
 * Kill the command only after this long with no output of any kind — a hung
 * command, not a slow one. Reset by every streamed event, so a call that keeps
 * making progress is never interrupted, however large the module.
 */
const IDLE_TIMEOUT_MS = 180_000;

/**
 * The `claude` argument vector for one authoring call. Print mode streaming
 * JSON (which `--verbose` is required for) with the schema inline; `--model` is
 * only passed when the identity pins one, so `default` uses the host's model.
 */
export function buildClaudeArgs(request: Omit<JsonAgentRequest<unknown>, "run">, schemaJson: string): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--json-schema",
    schemaJson,
    ...(request.identity.model === "default" ? [] : ["--model", request.identity.model]),
    ...(request.extraArgs ?? []),
  ];
}

function isResultEnvelope(value: unknown): value is ClaudeResultEnvelope {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result";
}

/**
 * Extract the schema-validated value from a Claude result envelope. Prefers the
 * parsed `structured_output`; falls back to parsing the `result` string. A
 * non-success envelope or unusable output is a {@link JsonAgentError}.
 */
export function valueFromEnvelope<T>(envelope: ClaudeResultEnvelope): T {
  if (envelope.is_error === true || (envelope.subtype !== undefined && envelope.subtype !== "success")) {
    const detail = envelope.api_error_status ?? envelope.subtype ?? "unknown error";
    throw new JsonAgentError("claude reported an error", String(detail));
  }
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return envelope.structured_output as T;
  }
  if (typeof envelope.result === "string") {
    try {
      return JSON.parse(envelope.result) as T;
    } catch {
      throw new JsonAgentError("claude result was not JSON", envelope.result.slice(0, 20_000));
    }
  }
  throw new JsonAgentError("claude returned no structured output", JSON.stringify(envelope).slice(0, 2_000));
}

/**
 * Find the terminating result event in a stream-json (JSONL) transcript and
 * extract its value. The result event is the last line; any earlier stream
 * event is ignored, and a line that only looks like one (prose containing the
 * marker) is confirmed by its parsed `type` before it counts.
 */
export function parseClaudeStream<T>(stdout: string): T {
  let envelope: ClaudeResultEnvelope | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.includes('"type":"result"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isResultEnvelope(parsed)) envelope = parsed;
  }
  if (envelope === null) throw new JsonAgentError("claude produced no result event", stdout.slice(-2_000));
  return valueFromEnvelope<T>(envelope);
}

/** Run one authoring call through the `claude` CLI. Generic over the response type. */
export function claudeCodeRunner<T>(request: Omit<JsonAgentRequest<T>, "run">): Promise<T> {
  const schemaJson = JSON.stringify(request.schema);
  const dir = mkdtempSync(join(tmpdir(), "project-analysis-claude-"));
  const args = buildClaudeArgs(request, schemaJson);
  const idleMs = request.timeoutMs ?? IDLE_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const child = spawn(request.command ?? "claude", args, {
      cwd: dir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Only the terminating result event is kept; every other line is discarded
    // as it streams, so memory stays bounded regardless of the transcript size.
    let pending = "";
    let resultEnvelope: ClaudeResultEnvelope | null = null;
    let stderr = "";
    let settled = false;
    let idle: ReturnType<typeof setTimeout>;

    // Settling never waits on the `close` event: a killed command whose children
    // still hold the stdout pipe can delay `close` indefinitely, which is exactly
    // the hang the idle guard exists to prevent. So a give-up path resolves the
    // promise itself and force-kills the process behind it.
    const settleResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      rmSync(dir, { recursive: true, force: true });
      resolve(value);
    };
    const settleReject = (error: JsonAgentError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      rmSync(dir, { recursive: true, force: true });
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      hardKill.unref();
      reject(error);
    };

    const bumpIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settleReject(new JsonAgentError("claude went idle and was terminated", `no output for ${Math.round(idleMs / 1000)}s`)),
        idleMs,
      );
    };

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "" || !trimmed.includes('"type":"result"')) return;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isResultEnvelope(parsed)) resultEnvelope = parsed;
      } catch {
        // A partial or non-JSON line — ignore it; the real result event is well-formed.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      bumpIdle();
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        consumeLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE_BYTES) {
        settleReject(new JsonAgentError("claude produced more output than expected", pending.slice(0, 2_000)));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      bumpIdle();
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });

    bumpIdle();

    child.once("error", (error) => settleReject(new JsonAgentError("failed to start claude", error.message)));
    child.once("close", (code, signal) => {
      if (settled) return;
      try {
        consumeLine(pending);
        if (code !== 0) {
          settleReject(new JsonAgentError(`claude exited with ${code ?? signal ?? "unknown status"}`, stderr.trim().slice(-20_000)));
          return;
        }
        if (resultEnvelope === null) {
          settleReject(new JsonAgentError("claude produced no result event", stderr.trim().slice(-2_000)));
          return;
        }
        settleResolve(valueFromEnvelope<T>(resultEnvelope));
      } catch (error) {
        settleReject(
          error instanceof JsonAgentError
            ? error
            : new JsonAgentError("claude returned unreadable output", error instanceof Error ? error.message : String(error)),
        );
      }
    });

    child.stdin.end(request.prompt, "utf8");
  });
}
