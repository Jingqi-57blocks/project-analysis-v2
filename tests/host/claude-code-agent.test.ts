import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildClaudeArgs, claudeCodeRunner, parseClaudeStream, valueFromEnvelope } from "../../engine/host/claude-code-agent.js";
import { JsonAgentError, type JsonAgentRequest } from "../../engine/host/json-agent.js";

const schema = { type: "object", additionalProperties: false, required: ["greeting"], properties: { greeting: { type: "string" } } } as const;

function request(overrides: Partial<Omit<JsonAgentRequest<unknown>, "run">> = {}): Omit<JsonAgentRequest<unknown>, "run"> {
  return {
    prompt: "author the greeting",
    schema,
    identity: { executor: "claude-code", model: "default", reasoningEffort: "medium" },
    ...overrides,
  };
}

/** A stream-json result line, as `claude` prints it last. */
function resultLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });
}

const scripts: string[] = [];

/** A throwaway executable that ignores its args, drains stdin, prints `body`, then exits `exitCode`. */
function fakeClaude(body: string, exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\ncat <<'ENVELOPE'\n${body}\nENVELOPE\nexit ${exitCode}\n`, "utf8");
  chmodSync(path, 0o755);
  scripts.push(dir);
  return path;
}

/** A throwaway executable that produces no output and just sleeps — a hung command. */
function fakeClaudeIdle(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-idle-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\nexec sleep 5\n`, "utf8");
  chmodSync(path, 0o755);
  scripts.push(dir);
  return path;
}

afterAll(() => {
  for (const dir of scripts) rmSync(dir, { recursive: true, force: true });
});

describe("buildClaudeArgs", () => {
  it("uses streaming print mode (which --verbose requires) with an inline schema and no --model for the default identity", () => {
    const args = buildClaudeArgs(request(), JSON.stringify(schema));
    expect(args).toEqual(["--print", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--json-schema", JSON.stringify(schema)]);
    expect(args).not.toContain("--model");
  });

  it("passes --model only when the identity pins one", () => {
    const args = buildClaudeArgs(request({ identity: { executor: "claude-code", model: "claude-sonnet-4-5", reasoningEffort: "low" } }), "{}");
    expect(args.slice(-2)).toEqual(["--model", "claude-sonnet-4-5"]);
  });

  it("appends extraArgs after the built vector", () => {
    const args = buildClaudeArgs(request({ extraArgs: ["--foo", "bar"] }), "{}");
    expect(args.slice(-2)).toEqual(["--foo", "bar"]);
  });
});

describe("valueFromEnvelope", () => {
  it("returns structured_output when present", () => {
    expect(valueFromEnvelope({ subtype: "success", structured_output: { greeting: "你好" }, result: "ignored" })).toEqual({ greeting: "你好" });
  });

  it("falls back to parsing the result string", () => {
    expect(valueFromEnvelope({ subtype: "success", result: '{"greeting":"hi"}' })).toEqual({ greeting: "hi" });
  });

  it("throws when the envelope reports an error", () => {
    expect(() => valueFromEnvelope({ is_error: true, subtype: "error_during_execution", api_error_status: "overloaded" })).toThrow(JsonAgentError);
  });

  it("throws when the subtype is not success", () => {
    expect(() => valueFromEnvelope({ subtype: "error_max_turns", result: "{}" })).toThrow(/error/i);
  });

  it("throws when the result string is not JSON", () => {
    expect(() => valueFromEnvelope({ subtype: "success", result: "plain prose" })).toThrow(/not JSON/i);
  });
});

describe("parseClaudeStream", () => {
  const streamEvent = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "…" } } });

  it("extracts the terminating result event from a JSONL transcript", () => {
    const transcript = [streamEvent, resultLine({ structured_output: { greeting: "hola" } })].join("\n");
    expect(parseClaudeStream(transcript)).toEqual({ greeting: "hola" });
  });

  it("ignores an earlier line whose prose merely contains the result marker", () => {
    const decoy = JSON.stringify({ type: "assistant", message: { text: 'I will emit {"type":"result"} shortly' } });
    const transcript = [decoy, resultLine({ structured_output: { greeting: "real" } })].join("\n");
    expect(parseClaudeStream(transcript)).toEqual({ greeting: "real" });
  });

  it("throws when no result event is present", () => {
    expect(() => parseClaudeStream([streamEvent, streamEvent].join("\n"))).toThrow(/no result event/i);
  });

  it("surfaces an error result event", () => {
    expect(() => parseClaudeStream(resultLine({ subtype: "error_max_turns" }))).toThrow(JsonAgentError);
  });
});

describe("claudeCodeRunner", () => {
  const streamEvent = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } });

  it("resolves to the structured output from the streamed result event", async () => {
    const command = fakeClaude([streamEvent, resultLine({ structured_output: { greeting: "hola" } })].join("\n"));
    expect(await claudeCodeRunner<{ greeting: string }>(request({ command }))).toEqual({ greeting: "hola" });
  });

  it("rejects with a JsonAgentError when the command cannot start", async () => {
    await expect(claudeCodeRunner(request({ command: "definitely-not-a-real-binary-xyzzy" }))).rejects.toBeInstanceOf(JsonAgentError);
  });

  it("rejects when the command exits non-zero", async () => {
    const command = fakeClaude("boom", 1);
    await expect(claudeCodeRunner(request({ command }))).rejects.toThrow(/exited with 1/);
  });

  it("terminates a command that goes idle and reports it", async () => {
    const command = fakeClaudeIdle();
    await expect(claudeCodeRunner(request({ command, timeoutMs: 200 }))).rejects.toThrow(/went idle/i);
  });
});
