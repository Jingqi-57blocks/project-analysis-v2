import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fileURLToPath } from "node:url";

import { main } from "../../scripts/flow.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/flow.ts", import.meta.url));

/**
 * One throwaway repository per shape, driven through `main` so that the exit code
 * is what is asserted. Every case here is a state the check once got wrong: three
 * review rounds found them, and each is named for what it used to do.
 */

const BASE = "feat/integration";

describe("the shapes that used to exit zero", () => {
  /** A repository with a base and whatever the caller builds on top. */
  function repoWith(build: (run: (...args: readonly string[]) => string, dir: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), "pa-flow-case-"));
    const run = (...args: readonly string[]) =>
      execFileSync("git", args as string[], { cwd: dir, encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    writeFileSync(join(dir, "f"), "a");
    run("add", "-A");
    run("commit", "-q", "-m", "initial");
    run("checkout", "-q", "-b", BASE);
    build(run, dir);
    return dir;
  }

  /** Runs the command itself, so the exit code is what is being asserted. */
  function exitCode(dir: string): { code: number; output: string } {
    const lines: string[] = [];
    const code = main({ PA_FLOW_BASE: BASE }, dir, (line) => lines.push(line), (line) => lines.push(line));
    return { code, output: lines.join("\n") };
  }

  /** One file per commit, so that merging two branches cannot conflict. */
  function commitIn(run: (...args: readonly string[]) => string, dir: string, subject: string): void {
    writeFileSync(join(dir, subject.replace(/[^a-z0-9]/gi, "-")), subject);
    run("add", "-A");
    run("commit", "-q", "-m", subject);
  }

  it("fails a stack where the two branches each merged a shared unlanded branch", () => {
    // `git merge-base` returns one base, and the one it returned was the landed
    // one, so the shared groundwork went unnoticed.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "shared-groundwork");
      commitIn(run, at, "wip: shared groundwork");
      run("checkout", "-q", BASE);
      commitIn(run, at, "57B-2: the base moves on");
      run("checkout", "-q", "-b", "57b-80", BASE);
      run("merge", "-q", "--no-ff", "-m", "Merge shared groundwork", "shared-groundwork");
      commitIn(run, at, "57B-80: its own work");
      run("checkout", "-q", "-b", "57b-81", BASE);
      run("merge", "-q", "--no-ff", "-m", "Merge shared groundwork", "shared-groundwork");
      commitIn(run, at, "57B-81: its own work");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("shares unlanded commits");
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports, without failing, a stack whose fork point was rewritten", () => {
    // Amending the commit the child was cut from leaves no shared commit at all,
    // and the pair reads as two independent branches. All that is left is the
    // title the child's copy still carries, which two people writing `wip` and
    // two branches reverting one base commit also produce — so it is printed for
    // a reader to judge and never failed.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-50");
      commitIn(run, at, "wip on the parent");
      run("checkout", "-q", "-b", "57b-51");
      commitIn(run, at, "57B-51: child work");
      run("checkout", "-q", "57b-50");
      writeFileSync(join(at, "wip-on-the-parent"), "rewritten");
      run("add", "-A");
      run("commit", "-q", "--amend", "-m", "wip on the parent");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("holds a commit titled the same as one on 57b-51");
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a stack whose parent exists only on the remote", () => {
    // `refs/heads` alone missed it, and detection fell back to commit subjects.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-70");
      commitIn(run, at, "wip on the parent");
      run("checkout", "-q", "-b", "57b-71");
      commitIn(run, at, "57B-71: child work");
      // A remote that is this repository, so a fetch produces a real remote ref.
      run("remote", "add", "origin", at);
      run("fetch", "-q", "origin", "57b-70:refs/remotes/origin/57b-70");
      run("branch", "-D", "57b-70");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("origin/57b-70");
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not read a remote copy of a branch as another issue's work", () => {
    // The same branch pushed and fetched back shares all of its history with
    // itself, which would have every pushed branch fail against its own copy.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-90");
      commitIn(run, at, "57B-90: its own work");
      run("remote", "add", "origin", at);
      run("fetch", "-q", "origin", "57b-90:refs/remotes/origin/57b-90");
    });
    try {
      expect(exitCode(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a branch with no history in common at all", () => {
    // `git merge-base` fails when there is no common ancestor, and the failure
    // took the whole report with it.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-91");
      commitIn(run, at, "57B-91: its own work");
      run("checkout", "-q", "--orphan", "57b-92");
      commitIn(run, at, "57B-92: an unrelated history");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("57b-91");
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports work behind an unread name even where nothing was read", () => {
    // The early return for "no issue branches" printed that and stopped, so work
    // behind a prefixed name was invisible under a report saying there was none.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "jz/57b-960");
      commitIn(run, at, "57B-960: work behind a prefixed name");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("No issue branches.");
      expect(output).toContain("jz/57b-960");
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names a mistyped branch that holds work, rather than passing over it", () => {
    // Three ways of missing the naming convention, all holding real work: a
    // separator that is not a dash, no separator at all, and a second number.
    const dir = repoWith((run, at) => {
      for (const name of ["57b_86", "57b300", "57b-85-2"]) {
        run("checkout", "-q", "-b", name, BASE);
        commitIn(run, at, `work on ${name}`);
      }
    });
    try {
      const { output } = exitCode(dir);
      for (const name of ["57b_86", "57b300", "57b-85-2"]) expect(output).toContain(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a tag sharing a branch's name without taking the tag's commits", () => {
    // Every fact came from the tag, so a genuinely stacked branch read as holding
    // nothing at all.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-900");
      commitIn(run, at, "57B-900: parent work");
      run("checkout", "-q", "-b", "57b-901");
      commitIn(run, at, "57B-901: child work");
      run("tag", "57b-901", BASE);
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("57b-901");
      expect(output).not.toContain("nothing beyond");
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes two clean branches that happen to share a commit title", () => {
    // `wip`, `fixup! …`, and `Revert "<a base commit>"` — which git writes
    // identically on any branch that reverts it — are ordinary, and failing them
    // would fail work with nothing wrong with it.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-40", BASE);
      commitIn(run, at, "wip");
      commitIn(run, at, "57B-40: its own work");
      run("checkout", "-q", "-b", "57b-41", BASE);
      writeFileSync(join(at, "wip-elsewhere"), "different content, same title");
      run("add", "-A");
      run("commit", "-q", "-m", "wip");
      commitIn(run, at, "57B-41: its own work");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("holds a commit titled the same as one on");
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a real stack even where a tag has taken the base's name", () => {
    // Branch refs were qualified and the base was not, so a tag of the same name
    // won `rev-parse` and every distance was measured from the tag instead. git
    // printed an ambiguity warning four times and the check exited zero.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-30", BASE);
      commitIn(run, at, "57B-30: parent work");
      run("checkout", "-q", "-b", "57b-31", "57b-30");
      commitIn(run, at, "57B-31: child work");
      run("tag", BASE, "57b-30");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(output).toContain("57b-31 is built on 57b-30");
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says the base is not a branch here, rather than measuring from a tag in silence", () => {
    // A tag left behind by a deleted branch of the same name reads as the base, and
    // a real stack then reported as two branches holding nothing.
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-10", BASE);
      commitIn(run, at, "57B-10: parent work");
      run("checkout", "-q", "-b", "57b-11", "57b-10");
      commitIn(run, at, "57B-11: child work");
      run("tag", BASE, "57b-10");
      run("checkout", "-q", "main");
      run("branch", "-D", BASE);
    });
    try {
      const { output } = exitCode(dir);
      expect(output).toContain(`"${BASE}" is not a local branch here`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a repository whose branches are each cut from the base", () => {
    const dir = repoWith((run, at) => {
      run("checkout", "-q", "-b", "57b-93", BASE);
      commitIn(run, at, "57B-93: its own work");
      run("checkout", "-q", "-b", "57b-94", BASE);
      commitIn(run, at, "57B-94: its own work");
    });
    try {
      const { code, output } = exitCode(dir);
      expect(code).toBe(0);
      expect(output).not.toContain("forbids");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, naming the base, where the base does not exist here", () => {
    const dir = repoWith(() => {});
    try {
      const lines: string[] = [];
      const code = main({ PA_FLOW_BASE: "feat/not-here" }, dir, () => {}, (line) => lines.push(line));
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain('No branch "feat/not-here" here');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the command's own exit code", () => {
  /** Spawns the script, because a returned integer is not what a shell reads. */
  function spawn(cwd: string): { status: number | null; stdout: string } {
    const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [tsx, SCRIPT], {
      cwd,
      env: { ...process.env, PA_FLOW_BASE: BASE },
      encoding: "utf8",
    });
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
  }

  function repo(build: (run: (...args: readonly string[]) => string, dir: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), "pa-flow-exit-"));
    const run = (...args: readonly string[]) =>
      execFileSync("git", args as string[], { cwd: dir, encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    writeFileSync(join(dir, "f"), "a");
    run("add", "-A");
    run("commit", "-q", "-m", "initial");
    run("checkout", "-q", "-b", BASE);
    build(run, dir);
    return dir;
  }

  it("exits zero where nothing is wrong", () => {
    const dir = repo((run, at) => {
      run("checkout", "-q", "-b", "57b-95", BASE);
      writeFileSync(join(at, "own"), "x");
      run("add", "-A");
      run("commit", "-q", "-m", "57B-95: its own work");
    });
    try {
      const { status, stdout } = spawn(dir);
      expect(stdout).toContain("57b-95");
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero on a stack, which is the whole contract", () => {
    // `main` returning 1 was asserted; the process exiting 1 was not, so removing
    // `process.exit` altogether left every test passing and the check toothless.
    const dir = repo((run, at) => {
      run("checkout", "-q", "-b", "57b-96", BASE);
      writeFileSync(join(at, "parent"), "x");
      run("add", "-A");
      run("commit", "-q", "-m", "57B-96: parent work");
      run("checkout", "-q", "-b", "57b-97");
      writeFileSync(join(at, "child"), "x");
      run("add", "-A");
      run("commit", "-q", "-m", "57B-97: child work");
    });
    try {
      const { status, stdout } = spawn(dir);
      expect(stdout).toContain("57b-97 is built on 57b-96");
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
