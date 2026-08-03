import { describe, expect, it } from "vitest";

import { EXECUTORS, isExecutorId, resolveExecutor } from "../../engine/report/executor.js";

describe("executor selection", () => {
  it("recognises the known executor ids and rejects others", () => {
    expect(EXECUTORS).toEqual(["codex", "claude-code"]);
    expect(isExecutorId("codex")).toBe(true);
    expect(isExecutorId("claude-code")).toBe(true);
    expect(isExecutorId("gpt")).toBe(false);
    expect(isExecutorId("")).toBe(false);
  });

  it("keeps codex on the port default (no injected runner) under its recorded label", () => {
    const resolved = resolveExecutor("codex");
    expect(resolved.executorKind).toBe("codex-cli");
    expect(resolved.run).toBeUndefined();
  });

  it("routes claude-code to an injected runner under its own label", () => {
    const resolved = resolveExecutor("claude-code");
    expect(resolved.executorKind).toBe("claude-code");
    expect(typeof resolved.run).toBe("function");
  });
});
