/**
 * A small, model-agnostic JSON authoring port backed by an external command.
 *
 * The analyzer owns the prompt, evidence bundle and output schema. The command
 * receives those bytes in an empty temporary working directory and returns one
 * schema-validated JSON value; it is never asked to inspect the analyzed source.
 * Codex CLI is the default adapter because it is already available in the host
 * environment, but callers may inject another command or a fake runner.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JsonAgentIdentity {
  readonly executor: string;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
}

export interface JsonAgentRequest<T> {
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly identity: JsonAgentIdentity;
  readonly timeoutMs?: number;
  readonly command?: string;
  readonly extraArgs?: readonly string[];
  /** Test hook or alternate adapter. */
  readonly run?: JsonAgentRunner<T>;
}

export type JsonAgentRunner<T> = (request: Omit<JsonAgentRequest<T>, "run">) => Promise<T>;

export class JsonAgentError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = "JsonAgentError";
  }
}

function defaultRunner<T>(request: Omit<JsonAgentRequest<T>, "run">): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "project-analysis-agent-"));
  const schemaPath = join(dir, "output.schema.json");
  const outputPath = join(dir, "output.json");
  writeFileSync(schemaPath, `${JSON.stringify(request.schema)}\n`, "utf8");

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    dir,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--color",
    "never",
    "--config",
    `model_reasoning_effort=\"${request.identity.reasoningEffort}\"`,
    ...(request.identity.model === "default" ? [] : ["--model", request.identity.model]),
    ...(request.extraArgs ?? []),
    "-",
  ];

  return new Promise<T>((resolve, reject) => {
    const child = spawn(request.command ?? "codex", args, {
      cwd: dir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 200_000) stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, request.timeoutMs ?? 480_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      rmSync(dir, { recursive: true, force: true });
      reject(new JsonAgentError(`failed to start ${request.command ?? "codex"}`, error.message));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) {
          reject(
            new JsonAgentError(
              `JSON agent exited with ${code ?? signal ?? "unknown status"}`,
              [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").slice(-20_000),
            ),
          );
          return;
        }
        const raw = readFileSync(outputPath, "utf8");
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(
          error instanceof JsonAgentError
            ? error
            : new JsonAgentError("JSON agent returned unreadable output", error instanceof Error ? error.message : String(error)),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    child.stdin.end(request.prompt, "utf8");
  });
}

export function runJsonAgent<T>(request: JsonAgentRequest<T>): Promise<T> {
  const { run, ...portable } = request;
  return (run ?? defaultRunner)(portable);
}

