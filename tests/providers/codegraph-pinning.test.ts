import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The version and schema the batch read is pinned to, and what happens when
 * either differs.
 *
 * This is a boundary against a tool that ships on its own schedule, so the
 * question these answer is not "does the check exist" but "does a mismatch stop
 * the run". It did not: preflight accepted any installed version, the schema
 * mismatch downgraded to a nodes-only read, and the run published a base with
 * no call relationships in it.
 */

vi.mock("../../engine/providers/codegraph/cli.js", async () => {
  const actual = await vi.importActual<typeof import("../../engine/providers/codegraph/cli.js")>(
    "../../engine/providers/codegraph/cli.js",
  );
  return { ...actual, codegraphVersion: () => installed };
});

let installed: string | null = "1.5.0";

const { VERIFIED_VERSION } = await import("../../engine/providers/codegraph/cli.js");
const { CodeIndexDegradedError, createCodeGraphProvider } = await import("../../engine/providers/codegraph/provider.js");

afterEach(() => {
  installed = "1.5.0";
});

describe("preflight against the pinned CodeGraph", () => {
  it("accepts the version this adapter was verified against", () => {
    installed = VERIFIED_VERSION;
    expect(createCodeGraphProvider().preflight()).toEqual({ available: true, version: VERIFIED_VERSION });
  });

  it("refuses a different version, and names both", () => {
    installed = "1.6.0";
    const result = createCodeGraphProvider().preflight();

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("1.6.0");
    expect(result.reason).toContain(VERIFIED_VERSION);
  });

  it("accepts a different version once degrading was asked for", () => {
    installed = "1.6.0";
    expect(createCodeGraphProvider({ allowDegraded: true }).preflight()).toEqual({
      available: true,
      version: "1.6.0",
    });
  });

  it("still refuses when nothing is installed, whatever was allowed", () => {
    installed = null;
    const result = createCodeGraphProvider({ allowDegraded: true }).preflight();

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("not installed");
  });
});

describe("reading an index this build cannot read as verified", () => {
  it("names the missing call graph, not just the schema number", () => {
    const error = new CodeIndexDegradedError('{"kind":"schema-unsupported","found":"9","supported":"8"}');

    expect(error.message).toContain("call relationships");
    expect(error.message).toContain("--allow-degraded");
    expect(error.message).toContain(VERIFIED_VERSION);
  });
});
