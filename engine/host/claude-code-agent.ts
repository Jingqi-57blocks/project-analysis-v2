/**
 * A Claude Code adapter for the model-agnostic JSON authoring port.
 *
 * It satisfies the same {@link JsonAgentRunner} seam the Codex adapter does, so
 * the classifier, the batch author and its repair passes can be routed to the
 * `claude` CLI without any engine change. The command runs in `--print` mode in
 * an empty temporary working directory, receives the prompt on stdin and the
 * output schema inline, and returns the one schema-validated JSON value Claude's
 * structured output produces; it is never asked to inspect the analyzed source.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonAgentError, type JsonAgentRequest } from "./json-agent.js";

/** The result envelope `claude -p --output-format json` prints on stdout. */
interface ClaudeResultEnvelope {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly api_error_status?: string | null;
  readonly result?: string;
  readonly structured_output?: unknown;
}

/** Cap stdout so a runaway command cannot exhaust memory; the envelope is one JSON object. */
const MAX_STDOUT_BYTES = 16_000_000;
const MAX_STDERR_BYTES = 200_000;

/**
 * Authoring a whole module document is one large call, and a capable model may
 * think for several minutes over it — the Codex-tuned 8-minute default is too
 * tight and truncates the work. Twenty minutes leaves headroom while still
 * bounding a genuinely hung command.
 */
const DEFAULT_TIMEOUT_MS = 1_200_000;

/**
 * The `claude` argument vector for one authoring call. Print mode with a single
 * JSON result and the schema inline; `--model` is only passed when the identity
 * pins one, so `default` uses the host's configured model.
 */
export function buildClaudeArgs(request: Omit<JsonAgentRequest<unknown>, "run">, schemaJson: string): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    schemaJson,
    ...(request.identity.model === "default" ? [] : ["--model", request.identity.model]),
    ...(request.extraArgs ?? []),
  ];
}

/**
 * Extract the schema-validated value from a Claude result envelope. Prefers the
 * parsed `structured_output`; falls back to parsing the `result` string. A
 * non-success envelope or unparseable output is a {@link JsonAgentError}.
 */
export function parseClaudeEnvelope<T>(stdout: string): T {
  let envelope: ClaudeResultEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeResultEnvelope;
  } catch {
    throw new JsonAgentError("claude returned unreadable output", stdout.slice(-20_000));
  }
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
  throw new JsonAgentError("claude returned no structured output", stdout.slice(-2_000));
}

/** Run one authoring call through the `claude` CLI. Generic over the response type. */
export function claudeCodeRunner<T>(request: Omit<JsonAgentRequest<T>, "run">): Promise<T> {
  const schemaJson = JSON.stringify(request.schema);
  const dir = mkdtempSync(join(tmpdir(), "project-analysis-claude-"));
  const args = buildClaudeArgs(request, schemaJson);

  return new Promise<T>((resolve, reject) => {
    const child = spawn(request.command ?? "claude", args, {
      cwd: dir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_BYTES) {
        overflowed = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });

    const timeout = setTimeout(() => child.kill("SIGTERM"), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.once("error", (error) => {
      clearTimeout(timeout);
      rmSync(dir, { recursive: true, force: true });
      reject(new JsonAgentError("failed to start claude", error.message));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      try {
        if (overflowed) {
          reject(new JsonAgentError("claude produced more output than expected", stdout.slice(0, 2_000)));
          return;
        }
        if (code !== 0) {
          reject(
            new JsonAgentError(
              `claude exited with ${code ?? signal ?? "unknown status"}`,
              [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").slice(-20_000),
            ),
          );
          return;
        }
        resolve(parseClaudeEnvelope<T>(stdout));
      } catch (error) {
        reject(
          error instanceof JsonAgentError
            ? error
            : new JsonAgentError("claude returned unreadable output", error instanceof Error ? error.message : String(error)),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    child.stdin.end(request.prompt, "utf8");
  });
}
