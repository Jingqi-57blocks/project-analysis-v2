import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { snapshotRoot } from "../../engine/snapshot/rootsnapshot.js";

let workDir: string;

function write(root: string, relativePath: string, contents: string): void {
  const full = join(workDir, root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-rootsnapshot-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("snapshotRoot — non-git", () => {
  it("captures a content digest and marks vcs as none", () => {
    write("plain", "index.ts", "export const a = 1;\n");
    const snapshot = snapshotRoot({
      name: "plain",
      path: join(workDir, "plain"),
      isGitRepo: false,
    });

    expect(snapshot.vcs).toBe("none");
    expect(snapshot.contentDigest.length).toBeGreaterThan(0);
    expect(snapshot.commitSha).toBeNull();
    expect(snapshot.branch).toBeNull();
    expect(snapshot.dirty).toBeNull();
  });

  it("changes digest when a file changes", () => {
    write("plain", "index.ts", "export const a = 1;\n");
    const before = snapshotRoot({ name: "plain", path: join(workDir, "plain"), isGitRepo: false });

    write("plain", "index.ts", "export const a = 2;\n");
    const after = snapshotRoot({ name: "plain", path: join(workDir, "plain"), isGitRepo: false });

    expect(after.contentDigest).not.toBe(before.contentDigest);
  });
});

describe("snapshotRoot — git", () => {
  function initRepo(root: string): void {
    const path = join(workDir, root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
    execFileSync("git", ["add", "-A"], { cwd: path });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "initial"],
      { cwd: path },
    );
  }

  it("captures commit, branch, and clean dirty state", () => {
    write("repo", "index.ts", "export const a = 1;\n");
    initRepo("repo");

    const snapshot = snapshotRoot({ name: "repo", path: join(workDir, "repo"), isGitRepo: true });

    expect(snapshot.vcs).toBe("git");
    expect(snapshot.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.dirty).toBe(false);
  });

  it("reports dirty when the working tree has uncommitted changes", () => {
    write("repo", "index.ts", "export const a = 1;\n");
    initRepo("repo");
    write("repo", "index.ts", "export const a = 2;\n");

    expect(snapshotRoot({ name: "repo", path: join(workDir, "repo"), isGitRepo: true }).dirty).toBe(
      true,
    );
  });

  it("still records a content digest for a dirty root", () => {
    write("repo", "index.ts", "export const a = 1;\n");
    initRepo("repo");
    write("repo", "index.ts", "export const a = 2;\n");

    const snapshot = snapshotRoot({ name: "repo", path: join(workDir, "repo"), isGitRepo: true });
    expect(snapshot.contentDigest.length).toBeGreaterThan(0);
  });

  it("does not downgrade to vcs none when git info cannot be read", () => {
    // A directory with .git but no commits: readGitInfo returns null. This must
    // not be mistaken for "not a git repository" — it is an honest partial.
    const path = join(workDir, "empty-repo");
    mkdirSync(path, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });

    const snapshot = snapshotRoot({ name: "empty-repo", path, isGitRepo: true });

    expect(snapshot.vcs).toBe("git");
    expect(snapshot.commitSha).toBeNull();
    expect(snapshot.branch).toBeNull();
    expect(snapshot.dirty).toBeNull();
    expect(snapshot.contentDigest.length).toBeGreaterThan(0);
  });
});
