import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildClaudeArgs, claudeCodeRunner, parseClaudeEnvelope } from "../../engine/host/claude-code-agent.js";
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

/** A throwaway executable that ignores its args, drains stdin and prints `body` on stdout with `exitCode`. */
const scripts: string[] = [];
function fakeClaude(body: string, exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\ncat <<'ENVELOPE'\n${body}\nENVELOPE\nexit ${exitCode}\n`, "utf8");
  chmodSync(path, 0o755);
  scripts.push(dir);
  return path;
}

afterAll(() => {
  for (const dir of scripts) rmSync(dir, { recursive: true, force: true });
});

describe("buildClaudeArgs", () => {
  it("uses print mode with an inline schema and no --model for the default identity", () => {
    const args = buildClaudeArgs(request(), JSON.stringify(schema));
    expect(args).toEqual(["--print", "--output-format", "json", "--json-schema", JSON.stringify(schema)]);
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

describe("parseClaudeEnvelope", () => {
  it("returns the parsed structured_output when present", () => {
    const value = parseClaudeEnvelope<{ greeting: string }>(JSON.stringify({ subtype: "success", is_error: false, structured_output: { greeting: "你好" }, result: "ignored" }));
    expect(value).toEqual({ greeting: "你好" });
  });

  it("falls back to parsing the result string when structured_output is absent", () => {
    const value = parseClaudeEnvelope<{ greeting: string }>(JSON.stringify({ subtype: "success", result: '{"greeting":"hi"}' }));
    expect(value).toEqual({ greeting: "hi" });
  });

  it("throws when the envelope reports an error", () => {
    expect(() => parseClaudeEnvelope(JSON.stringify({ is_error: true, subtype: "error_during_execution", api_error_status: "overloaded" }))).toThrow(JsonAgentError);
  });

  it("throws when the subtype is not success", () => {
    expect(() => parseClaudeEnvelope(JSON.stringify({ subtype: "error_max_turns", result: "{}" }))).toThrow(/error/i);
  });

  it("throws on non-JSON stdout", () => {
    expect(() => parseClaudeEnvelope("not json at all")).toThrow(/unreadable/i);
  });

  it("throws when a successful envelope carries no usable output", () => {
    expect(() => parseClaudeEnvelope(JSON.stringify({ subtype: "success" }))).toThrow(/no structured output/i);
  });

  it("throws when the result string is not JSON", () => {
    expect(() => parseClaudeEnvelope(JSON.stringify({ subtype: "success", result: "plain prose, not json" }))).toThrow(/not JSON/i);
  });
});

describe("claudeCodeRunner", () => {
  it("resolves to the structured output the command prints", async () => {
    const command = fakeClaude(JSON.stringify({ subtype: "success", is_error: false, structured_output: { greeting: "hola" } }));
    const value = await claudeCodeRunner<{ greeting: string }>(request({ command }));
    expect(value).toEqual({ greeting: "hola" });
  });

  it("rejects with a JsonAgentError when the command cannot start", async () => {
    await expect(claudeCodeRunner(request({ command: "definitely-not-a-real-binary-xyzzy" }))).rejects.toBeInstanceOf(JsonAgentError);
  });

  it("rejects when the command exits non-zero", async () => {
    const command = fakeClaude("boom", 1);
    await expect(claudeCodeRunner(request({ command }))).rejects.toThrow(/exited with 1/);
  });
});
