import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readGitInfo } from "../../engine/snapshot/gitinfo.js";

let repo: string;

function git(args: readonly string[]): string {
  return execFileSync("git", args as string[], { cwd: repo, encoding: "utf8" }).trim();
}

function commit(message: string): void {
  git(["add", "-A"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pa-gitinfo-"));
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  commit("initial");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("readGitInfo", () => {
  it("reads the current commit and branch on a clean repo", () => {
    const info = readGitInfo(repo);
    expect(info?.dirty).toBe(false);
    expect(info?.branch).toBe("main");
    expect(info?.commitSha).toBe(git(["rev-parse", "HEAD"]));
  });

  it("reports dirty when there are uncommitted changes", () => {
    writeFileSync(join(repo, "a.txt"), "two\n");
    expect(readGitInfo(repo)?.dirty).toBe(true);
  });

  it("reports dirty for an untracked file", () => {
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    expect(readGitInfo(repo)?.dirty).toBe(true);
  });

  it("reports clean once changes are committed", () => {
    writeFileSync(join(repo, "a.txt"), "two\n");
    commit("second");
    expect(readGitInfo(repo)?.dirty).toBe(false);
  });

  it("reports a null branch on a detached HEAD", () => {
    const sha = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", sha]);
    expect(readGitInfo(repo)?.branch).toBeNull();
  });

  it("reflects a new commit's sha", () => {
    const before = readGitInfo(repo)?.commitSha;
    writeFileSync(join(repo, "b.txt"), "x\n");
    commit("another");
    expect(readGitInfo(repo)?.commitSha).not.toBe(before);
  });

  it("returns null when the path is not a git repository", () => {
    const plain = mkdtempSync(join(tmpdir(), "pa-gitinfo-plain-"));
    try {
      expect(readGitInfo(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("returns null on a repository with no commits yet", () => {
    const empty = mkdtempSync(join(tmpdir(), "pa-gitinfo-empty-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
      // rev-parse HEAD fails with no commits — this is the "git commands fail
      // unexpectedly" case callers must treat as an honest partial, not as
      // "not a git repo".
      expect(readGitInfo(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
