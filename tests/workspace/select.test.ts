import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyDirectory } from "../../engine/workspace/discover.js";
import { selectWorkspace } from "../../engine/workspace/select.js";
import { analyzedRoots, WorkspaceSelectionError } from "../../engine/workspace/types.js";

let workDir: string;

function write(relativePath: string, contents = "x"): void {
  const full = join(workDir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function dir(relativePath: string): string {
  const full = join(workDir, relativePath);
  mkdirSync(full, { recursive: true });
  return full;
}

/** A container holding three project directories, each a plausible root. */
function seedContainer(): string {
  write("alpha/package.json", "{}");
  write("alpha/src/index.ts", "export const a = 1;");
  write("beta/go.mod", "module example.com/beta");
  write("beta/main.go", "package main");
  write("gamma/main.py", "print('hi')");
  return workDir;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-select-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("classifyDirectory", () => {
  it("treats a directory with a manifest as a root", () => {
    write("proj/package.json", "{}");
    expect(classifyDirectory(join(workDir, "proj")).isRoot).toBe(true);
  });

  it("treats a directory with its own .git as a root", () => {
    write("proj/.git/HEAD", "ref: refs/heads/main");
    expect(classifyDirectory(join(workDir, "proj")).isRoot).toBe(true);
  });

  it("treats a directory with top-level source files as a root", () => {
    write("proj/main.go", "package main");
    expect(classifyDirectory(join(workDir, "proj")).isRoot).toBe(true);
  });

  it("treats a directory of project directories as a container", () => {
    seedContainer();
    const verdict = classifyDirectory(workDir);
    expect(verdict.isRoot).toBe(false);
    expect(verdict.reason).toContain("container");
  });

  it("does not treat a project's own subfolders as roots", () => {
    // The failure this guards against: pointing at one service and getting its
    // internal packages analyzed as if they were separate projects.
    write("svc/go.mod", "module example.com/svc");
    write("svc/internal/handler/handler.go", "package handler");

    const selection = selectWorkspace({ paths: [join(workDir, "svc")] });

    expect(selection.mode).toBe("single-root");
    expect(analyzedRoots(selection).map((r) => r.name)).toEqual(["svc"]);
  });
});

describe("selectWorkspace", () => {
  it("discovers roots beneath a container", () => {
    seedContainer();
    const selection = selectWorkspace({ paths: [workDir] });

    expect(selection.mode).toBe("parent");
    expect(analyzedRoots(selection).map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("analyzes a single project as a workspace of one", () => {
    write("solo/package.json", "{}");
    const selection = selectWorkspace({ paths: [join(workDir, "solo")] });

    expect(selection.mode).toBe("single-root");
    expect(analyzedRoots(selection).length).toBe(1);
  });

  it("takes several paths as an explicit root list", () => {
    seedContainer();
    const selection = selectWorkspace({
      paths: [join(workDir, "alpha"), join(workDir, "beta")],
    });

    expect(selection.mode).toBe("explicit");
    expect(analyzedRoots(selection).map((r) => r.name)).toEqual(["alpha", "beta"]);
  });

  it("keeps only the requested subset", () => {
    seedContainer();
    const selection = selectWorkspace({ paths: [workDir], include: ["beta"] });

    expect(analyzedRoots(selection).map((r) => r.name)).toEqual(["beta"]);
  });

  it("drops excluded roots", () => {
    seedContainer();
    const selection = selectWorkspace({ paths: [workDir], exclude: ["beta"] });

    expect(analyzedRoots(selection).map((r) => r.name)).toEqual(["alpha", "gamma"]);
  });

  it("remembers roots it did not analyze, and why", () => {
    seedContainer();
    const selection = selectWorkspace({ paths: [workDir], exclude: ["beta"] });

    // A report describing a subset must be able to say so.
    expect(selection.roots.length).toBe(3);
    const beta = selection.roots.find((r) => r.name === "beta");
    expect(beta?.selected).toBe(false);
    expect(beta?.excludedReason).toContain("excluded");
  });

  it("records skipped directories with a reason rather than dropping them", () => {
    seedContainer();
    dir("node_modules");
    dir(".vscode");

    const selection = selectWorkspace({ paths: [workDir] });
    const skippedNames = selection.skipped.map((s) => s.name);

    expect(skippedNames).toContain("node_modules");
    expect(skippedNames).toContain(".vscode");
    for (const entry of selection.skipped) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it("notes a discovered root that is empty rather than omitting it", () => {
    seedContainer();
    dir("delta");

    const selection = selectWorkspace({ paths: [workDir] });
    expect(selection.roots.find((r) => r.name === "delta")?.isEmpty).toBe(true);
  });

  it("records whether each root has a manifest and version control", () => {
    seedContainer();
    write("alpha/.git/HEAD", "ref: refs/heads/main");

    const selection = selectWorkspace({ paths: [workDir] });
    const alpha = selection.roots.find((r) => r.name === "alpha");
    const gamma = selection.roots.find((r) => r.name === "gamma");

    expect(alpha?.hasManifest).toBe(true);
    expect(alpha?.isGitRepo).toBe(true);
    expect(gamma?.hasManifest).toBe(false);
    expect(gamma?.isGitRepo).toBe(false);
  });

  it("explains how it decided, so the outcome is inspectable", () => {
    seedContainer();
    expect(selectWorkspace({ paths: [workDir] }).modeReason.length).toBeGreaterThan(0);
  });
});

describe("selectWorkspace failures", () => {
  it("rejects a path that does not exist", () => {
    expect(() => selectWorkspace({ paths: [join(workDir, "absent")] })).toThrow(
      WorkspaceSelectionError,
    );
  });

  it("rejects a file given where a directory is required", () => {
    write("a-file.txt");
    expect(() => selectWorkspace({ paths: [join(workDir, "a-file.txt")] })).toThrow(
      /Not a directory/,
    );
  });

  it("rejects naming a root that was not discovered", () => {
    seedContainer();
    expect(() => selectWorkspace({ paths: [workDir], include: ["nope"] })).toThrow(
      /No root named "nope"/,
    );
  });

  it("refuses a selection that leaves nothing to analyze", () => {
    seedContainer();
    expect(() =>
      selectWorkspace({ paths: [workDir], exclude: ["alpha", "beta", "gamma"] }),
    ).toThrow(/left no roots/);
  });

  it("refuses an empty container rather than analyzing nothing", () => {
    expect(() => selectWorkspace({ paths: [dir("hollow")] })).toThrow(/no candidate roots/);
  });

  it("rejects being given no paths at all", () => {
    expect(() => selectWorkspace({ paths: [] })).toThrow(/No paths given/);
  });
});
