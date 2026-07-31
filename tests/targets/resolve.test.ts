import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envVarFor, TARGETS, targetIds } from "../support/targets/registry.js";
import { expandPath, resolveTarget } from "../support/targets/resolve.js";

const KNOWN_ID = TARGETS[0]!.id;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-resolve-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("registry", () => {
  it("has unique target ids", () => {
    expect(new Set(targetIds()).size).toBe(targetIds().length);
  });

  it("declares at least one root per target and explains its coverage", () => {
    for (const target of TARGETS) {
      expect(target.roots.length, `${target.id} roots`).toBeGreaterThan(0);
      expect(new Set(target.roots).size, `${target.id} duplicate roots`).toBe(target.roots.length);
      expect(target.covers.length, `${target.id} covers`).toBeGreaterThan(0);
    }
  });

  it("derives an environment variable name per target", () => {
    expect(envVarFor("wcp-v2")).toBe("PA_TARGET_WCP_V2");
    expect(envVarFor("angels-pizza")).toBe("PA_TARGET_ANGELS_PIZZA");
  });

  it("covers both version-control states across the registry", () => {
    const modes = new Set(TARGETS.map((t) => t.vcs));
    expect(modes).toContain("git");
    expect(modes).toContain("none");
  });
});

describe("expandPath", () => {
  it("expands a leading tilde", () => {
    expect(expandPath("~/somewhere")).not.toContain("~");
    expect(expandPath("~/somewhere").endsWith(join("somewhere"))).toBe(true);
  });

  it("leaves absolute paths alone", () => {
    expect(expandPath("/tmp/thing")).toBe("/tmp/thing");
  });
});

describe("resolveTarget", () => {
  it("reports unknown targets with the list of known ones", () => {
    const result = resolveTarget("no-such-target");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable.reason).toContain("Unknown target");
      expect(result.unavailable.reason).toContain(KNOWN_ID);
    }
  });

  it("reports an absent target with an actionable reason naming the override", () => {
    const env = { [envVarFor(KNOWN_ID)]: join(workDir, "not-here") };
    const result = resolveTarget(KNOWN_ID, { env });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable.reason).toContain("not found");
      expect(result.unavailable.reason).toContain(envVarFor(KNOWN_ID));
    }
  });

  it("resolves through an environment override and reports present roots", () => {
    const definition = TARGETS[0]!;
    const [firstRoot] = definition.roots;
    mkdirSync(join(workDir, firstRoot!), { recursive: true });

    const result = resolveTarget(definition.id, {
      env: { [envVarFor(definition.id)]: workDir },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.path).toBe(workDir);
      expect(result.target.roots.find((r) => r.name === firstRoot)?.present).toBe(true);
    }
  });

  it("names declared roots that are missing, rather than failing", () => {
    const definition = TARGETS[0]!;
    mkdirSync(join(workDir, definition.roots[0]!), { recursive: true });

    const result = resolveTarget(definition.id, {
      env: { [envVarFor(definition.id)]: workDir },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.missingRoots).toEqual([...definition.roots.slice(1)]);
    }
  });

  it("detects which roots are git repositories", () => {
    const definition = TARGETS[0]!;
    const root = definition.roots[0]!;
    mkdirSync(join(workDir, root, ".git"), { recursive: true });
    writeFileSync(join(workDir, root, ".git", "HEAD"), "ref: refs/heads/main\n");

    const result = resolveTarget(definition.id, {
      env: { [envVarFor(definition.id)]: workDir },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.roots.find((r) => r.name === root)?.isGitRepo).toBe(true);
    }
  });
});
