import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestDirectory, prepareFixture, type RootPlan } from "../scripts/setup-fixture.js";

/**
 * Tests run against a synthetic workspace rather than the real fixture, so they
 * stay meaningful while the fixture is still being built out and do not break
 * every time its contents change.
 */

const ROOTS: readonly RootPlan[] = [
  { name: "alpha", git: true },
  { name: "beta", git: true, dirty: true },
  { name: "gamma", git: false },
];

let workDir: string;
let sourceDir: string;
let outputDir: string;

function write(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function seedSource(): void {
  for (const root of ROOTS) {
    const dir = join(sourceDir, root.name);
    mkdirSync(dir, { recursive: true });
    write(join(dir, "README.md"), `# ${root.name}\n\nA fixture root.\n`);
    write(join(dir, "index.ts"), `export const name = "${root.name}";\n`);
  }
}

function prepare(force = false): ReturnType<typeof prepareFixture> {
  return prepareFixture({ sourceDir, outputDir, roots: ROOTS, force });
}

function gitStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: join(outputDir, root),
    encoding: "utf8",
  }).trim();
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-fixture-"));
  sourceDir = join(workDir, "source");
  outputDir = join(workDir, "prepared");
  seedSource();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("digestDirectory", () => {
  it("is stable across calls on unchanged content", () => {
    expect(digestDirectory(sourceDir)).toBe(digestDirectory(sourceDir));
  });

  it("changes when file contents change", () => {
    const before = digestDirectory(sourceDir);
    write(join(sourceDir, "alpha", "index.ts"), "export const name = 'changed';\n");
    expect(digestDirectory(sourceDir)).not.toBe(before);
  });

  it("changes when a file is renamed", () => {
    const before = digestDirectory(sourceDir);
    write(join(sourceDir, "alpha", "renamed.ts"), readFileSync(join(sourceDir, "alpha", "index.ts"), "utf8"));
    rmSync(join(sourceDir, "alpha", "index.ts"));
    expect(digestDirectory(sourceDir)).not.toBe(before);
  });
});

describe("prepareFixture", () => {
  it("copies the source and initialises the planned git roots", () => {
    const result = prepare();

    expect(result.rebuilt).toBe(true);
    expect(existsSync(join(outputDir, "alpha", "index.ts"))).toBe(true);

    const byRoot = new Map(result.roots.map((r) => [r.root, r]));
    expect(byRoot.get("alpha")?.isGitRepo).toBe(true);
    expect(byRoot.get("beta")?.isGitRepo).toBe(true);
    expect(byRoot.get("gamma")?.isGitRepo).toBe(false);
  });

  it("leaves the root marked dirty with uncommitted changes, and others clean", () => {
    prepare();

    expect(gitStatus("beta")).not.toBe("");
    expect(gitStatus("alpha")).toBe("");
  });

  it("never creates a git repository in the workspace root itself", () => {
    prepare();
    expect(existsSync(join(outputDir, ".git"))).toBe(false);
  });

  it("does nothing on a second run", () => {
    prepare();
    const second = prepare();

    expect(second.rebuilt).toBe(false);
    expect(second.roots.flatMap((r) => r.actions)).toEqual([]);
    expect(second.roots.find((r) => r.root === "beta")?.isDirty).toBe(true);
  });

  it("rebuilds when the source changes", () => {
    const first = prepare();
    write(join(sourceDir, "alpha", "extra.ts"), "export const extra = true;\n");
    const second = prepare();

    expect(second.rebuilt).toBe(true);
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
    expect(existsSync(join(outputDir, "alpha", "extra.ts"))).toBe(true);
  });

  it("rebuilds when forced even though the source is unchanged", () => {
    prepare();
    expect(prepare(true).rebuilt).toBe(true);
  });

  it("discards local edits to the prepared copy on rebuild", () => {
    prepare();
    write(join(outputDir, "alpha", "index.ts"), "// hand-edited\n");

    prepare(true);

    expect(readFileSync(join(outputDir, "alpha", "index.ts"), "utf8")).toContain("export const name");
  });

  it("reports roots that do not exist in the source yet", () => {
    const result = prepareFixture({
      sourceDir,
      outputDir,
      roots: [...ROOTS, { name: "not-yet-written", git: true }],
    });

    const missing = result.roots.find((r) => r.root === "not-yet-written");
    expect(missing?.present).toBe(false);
    expect(missing?.isGitRepo).toBeNull();
    expect(missing?.actions).toEqual([]);
  });

  it("excludes .git and node_modules from the copied source", () => {
    mkdirSync(join(sourceDir, "alpha", "node_modules"), { recursive: true });
    write(join(sourceDir, "alpha", "node_modules", "junk.js"), "module.exports = {};\n");

    prepare(true);

    expect(existsSync(join(outputDir, "alpha", "node_modules"))).toBe(false);
  });

  it("throws when the source directory is missing", () => {
    expect(() =>
      prepareFixture({ sourceDir: join(workDir, "absent"), outputDir, roots: ROOTS }),
    ).toThrow(/Fixture source not found/);
  });
});
