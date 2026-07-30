import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assess, deriveFacts, openPullRequests, readGit } from "../../scripts/flow.js";

/** No pull request lookup, so a test never depends on `gh` being installed. */
const none = () => null;

/**
 * `deriveFacts` is tested against stated repository shapes; this exercises the
 * reading that produces them, in a real repository. Both halves are needed: a
 * wrong `merge-base` range or a missing `--is-ancestor` is invisible to the
 * first, and every defect the reviewer found lived in one of the two.
 */

const BASE = "feat/integration";
let repo: string;

function git(...args: readonly string[]): string {
  return execFileSync("git", args as string[], { cwd: repo, encoding: "utf8" }).trim();
}

function commit(subject: string): void {
  writeFileSync(join(repo, "file.txt"), subject);
  git("add", "-A");
  git("commit", "-q", "-m", subject);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "pa-flow-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  commit("initial");
  git("checkout", "-q", "-b", BASE);
  commit("57B-201: something that landed");

  // Cut from the base, one commit of its own: the shape every issue should have.
  git("checkout", "-q", "-b", "57b-210", BASE);
  commit("57B-210: its own work");

  // Cut from an unlanded issue branch: the mistake this check exists for.
  git("checkout", "-q", "-b", "57b-211", "57b-210");
  commit("57B-211: work on the wrong base");

  // Landed: merged into the base, so nothing of its own remains beyond it.
  git("checkout", "-q", "-b", "57b-212", BASE);
  commit("57B-212: work that landed");
  git("checkout", "-q", BASE);
  git("merge", "-q", "--no-ff", "-m", "Merge 57b-212", "57b-212");

  // Freshly cut, nothing on it, and the base then moved on.
  git("checkout", "-q", "-b", "57b-213", BASE);
  git("checkout", "-q", BASE);
  commit("57B-214: the base moves on");

  // `main` gains work the base has never seen, and a branch is cut from it.
  git("checkout", "-q", "main");
  commit("57B-100: something on main only");
  git("checkout", "-q", "-b", "57b-215", "main");
  commit("57B-215: its own work, on the wrong base");

  // Cut from an unlanded branch that then commits again, so ancestry stops
  // holding — the shape that made the check fail open.
  git("checkout", "-q", "-b", "57b-217", BASE);
  commit("wip");
  git("checkout", "-q", "-b", "57b-218", "57b-217");
  commit("57B-218: work on a parent that moved");
  git("checkout", "-q", "57b-217");
  commit("57B-217: the parent commits again");

  // Two branches for one issue, each cut from the last: one piece of work.
  git("checkout", "-q", "-b", "57b-219-part-one", BASE);
  commit("57B-219: the first part");
  git("checkout", "-q", "-b", "57b-219-part-two", "57b-219-part-one");
  commit("57B-219: the second part");

  // Another name for one commit, which is not a base.
  git("branch", "57b-216", "57b-210");
  // Not an issue branch, so it should not appear at all.
  git("branch", "release-candidate", BASE);
  git("checkout", "-q", BASE);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("reading a real repository", () => {
  it("reads only branches named for an issue", () => {
    const state = readGit(BASE, repo, none);
    expect([...state.names].sort()).toEqual([
      "57b-210",
      "57b-211",
      "57b-212",
      "57b-213",
      "57b-215",
      "57b-216",
      "57b-217",
      "57b-218",
      "57b-219-part-one",
      "57b-219-part-two",
    ]);
    expect(state.names).not.toContain("release-candidate");
    expect(state.names).not.toContain(BASE);
  });

  it("names a branch it did not read, rather than passing over it in silence", () => {
    // A prefixed name is out of scope by choice, so work hidden behind one has
    // to announce itself.
    git("branch", "jz/57b-230", "57b-210");
    try {
      const state = readGit(BASE, repo, none);
      expect(state.unread).toEqual(["jz/57b-230"]);
      expect(state.names).not.toContain("jz/57b-230");
    } finally {
      git("branch", "-D", "jz/57b-230");
    }
  });

  it("says nothing about a prefixed branch holding no work of its own", () => {
    // Ten spent `feat/mvp-*` branches sit in this repository. Announcing those
    // on every run teaches the reader to skip the line that matters.
    git("branch", "feat/mvp-9-kb", BASE);
    try {
      expect(readGit(BASE, repo, none).unread).toEqual([]);
    } finally {
      git("branch", "-D", "feat/mvp-9-kb");
    }
  });

  it("still finds a branch whose name a tag shares", () => {
    // `refname:short` disambiguates to `heads/57b-210` when a tag of the same
    // name exists, and the branch then matched nothing and vanished entirely.
    git("tag", "57b-210", "57b-210");
    try {
      expect(readGit(BASE, repo, none).names).toContain("57b-210");
    } finally {
      git("tag", "-d", "57b-210");
    }
  });

  it("finds a parent that has moved on since the branch was cut", () => {
    // 57b-217 committed again after 57b-218 was cut from it, so it is no longer
    // an ancestor and the check exited zero on the very state it exists for.
    const facts = deriveFacts(readGit(BASE, repo, none));
    const parent = facts.find((f) => f.name === "57b-217")!;
    const child = facts.find((f) => f.name === "57b-218")!;
    expect(child.builtOn).toEqual([]);
    // Neither is an ancestor of the other once both have committed, so nothing
    // says which was cut from which and the pair is stated once, not twice.
    expect(parent.entangledWith).toEqual(["57b-218"]);
    expect(child.entangledWith).toEqual(["57b-217"]);
    expect(assess(facts, BASE).problems).toContain(
      "57b-217 holds unlanded commits also on 57b-218, which is another issue's branch",
    );
  });

  it("leaves two branches for one issue alone", () => {
    const facts = deriveFacts(readGit(BASE, repo, none));
    for (const name of ["57b-219-part-one", "57b-219-part-two"]) {
      const found = facts.find((f) => f.name === name)!;
      expect([...found.builtOn, ...found.entangledWith]).toEqual([]);
    }
  });

  it("lists what a branch holds that the base does not", () => {
    const state = readGit(BASE, repo, none);
    expect(state.subjectsSinceBase.get("57b-210")).toEqual(["57B-210: its own work"]);
    // Cut from `main`, so what it holds includes what `main` held: the commit
    // for another issue that makes its base visible as wrong.
    expect(state.subjectsSinceBase.get("57b-215")).toEqual([
      "57B-215: its own work, on the wrong base",
      "57B-100: something on main only",
    ]);
    // Its own commits only — the base's are never counted against a branch.
    expect(state.subjectsSinceBase.get("57b-213")).toEqual([]);
  });

  it("counts how far behind the base each branch is", () => {
    // 57b-210 was cut from the base and the base then gained three commits — a
    // merge, its second parent, and one more. Being behind is ordinary; a check
    // that failed on it would fail every branch here.
    const state = readGit(BASE, repo, none);
    // A merge, its second parent, and one commit after it.
    expect(state.missingFromBase.get("57b-210")).toBe(3);
    expect(state.missingFromBase.get("57b-213")).toBe(1);
  });

  it("finds the unlanded branch a stacked branch is built on", () => {
    const facts = deriveFacts(readGit(BASE, repo, none));
    const stacked = facts.find((f) => f.name === "57b-211")!;
    // Both names for that one commit, since both are unlanded work it sits on.
    expect(stacked.builtOn).toEqual(["57b-210", "57b-216"]);
    // And the branch it was cut from is not accused of the reverse.
    expect(facts.find((f) => f.name === "57b-210")!.builtOn).toEqual([]);
  });

  it("reads a merged branch and a freshly cut one as holding nothing of their own", () => {
    // Which is which is not in the graph, and every attempt to guess it from the
    // tip commit's subject called some brand-new branch merged work.
    const facts = deriveFacts(readGit(BASE, repo, none));
    for (const name of ["57b-212", "57b-213"]) {
      expect(facts.find((f) => f.name === name)!.behindBase).toBe(true);
    }
  });

  it("reads a second name for one commit as that, not as a base", () => {
    const facts = deriveFacts(readGit(BASE, repo, none));
    expect(facts.find((f) => f.name === "57b-210")!.sameCommitAs).toEqual(["57b-216"]);
    expect(facts.find((f) => f.name === "57b-216")!.builtOn).toEqual([]);
  });

  it("states every problem in this repository and no others", () => {
    const { problems } = assess(deriveFacts(readGit(BASE, repo, none)), BASE);
    expect(problems.toSorted()).toEqual([
      // Two names for one commit, and one of them is not named for its work.
      "57b-210 stands on the same commit as 57b-216, which is another issue's work",
      "57b-211 carries 1 commit(s) for 57B-210",
      `57b-211 is built on 57b-210, 57b-216 rather than ${BASE}`,
      // Cut from `main`, so it carries main's commit as well as its own.
      "57b-215 carries 1 commit(s) for 57B-100",
      // 57b-216 is a second name for 57b-210's commit, so it holds work that
      // belongs to the issue it is not named for.
      "57b-216 carries 1 commit(s) for 57B-210",
      "57b-217 holds unlanded commits also on 57b-218, which is another issue's branch",
    ]);
    // And the parent of a stack is not accused of being built on its own child.
    expect(problems.join("\n")).not.toContain("57b-210 shares");
    expect(problems.join("\n")).not.toContain("57b-218 shares");
  });

  it("passes a repository where every branch is cut from the base", () => {
    const clean = mkdtempSync(join(tmpdir(), "pa-flow-clean-"));
    try {
      const run = (...args: readonly string[]) =>
        execFileSync("git", args as string[], { cwd: clean, encoding: "utf8" });
      run("init", "-q", "-b", "main");
      run("config", "user.email", "test@example.com");
      run("config", "user.name", "Test");
      writeFileSync(join(clean, "a.txt"), "a");
      run("add", "-A");
      run("commit", "-q", "-m", "initial");
      run("checkout", "-q", "-b", BASE);
      run("checkout", "-q", "-b", "57b-220");
      writeFileSync(join(clean, "a.txt"), "b");
      run("add", "-A");
      run("commit", "-q", "-m", "57B-220: its own work");

      // The pull request lookup is stated rather than left to whatever `gh`
      // answers here: asserting an empty `owed` because `gh` happened to fail
      // asserted nothing, and went red the moment a real `gh` could answer.
      const noPullRequests = assess(deriveFacts(readGit(BASE, clean, () => new Set())), BASE);
      expect(noPullRequests.problems).toEqual([]);
      expect(noPullRequests.owed).toEqual(["57b-220"]);

      const covered = assess(deriveFacts(readGit(BASE, clean, () => new Set(["57b-220"]))), BASE);
      expect(covered.owed).toEqual([]);

      const unasked = assess(deriveFacts(readGit(BASE, clean, none)), BASE);
      expect(unasked.owed).toEqual([]);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});

describe("asking gh which branches have a pull request", () => {
  /**
   * A stub `gh`, reachable through an environment passed in rather than through
   * `process.env`. Mutating the real PATH raced every other test file: vitest
   * shares the environment across files in a worker, so a stub answering pull
   * requests changed what an unrelated repository's report said.
   */
  function withStubGh<T>(behaviour: string, run: (env: NodeJS.ProcessEnv, argsFile: string) => T): T {
    const bin = mkdtempSync(join(tmpdir(), "pa-flow-gh-"));
    const argsFile = join(bin, "args.txt");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" > ${argsFile}\n${behaviour}\n`);
    chmodSync(join(bin, "gh"), 0o755);
    try {
      return run({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, argsFile);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  it("reads the head branch of every open pull request", () => {
    const answered = withStubGh('echo \'[{"headRefName":"57b-210"},{"headRefName":"57b-211"}]\'', (env) =>
      openPullRequests(repo, env),
    );
    expect(answered).toEqual(new Set(["57b-210", "57b-211"]));
  });

  it("asks for open pull requests, not closed ones", () => {
    // A merged pull request left open in the query would read as covering
    // commits that are still unlanded — the one wrong answer that fails open.
    const args = withStubGh("echo '[]'", (env, argsFile) => {
      openPullRequests(repo, env);
      return readFileSync(argsFile, "utf8");
    });
    expect(args).toContain("--state open");
  });

  it("answers nothing at all when gh cannot", () => {
    // Missing, unauthenticated, offline, or answering something that is not
    // JSON: none of those establish that a branch has no pull request.
    expect(withStubGh("exit 1", (env) => openPullRequests(repo, env))).toBeNull();
    expect(withStubGh("echo not-json", (env) => openPullRequests(repo, env))).toBeNull();
  });

  it("distinguishes no pull requests from no answer", () => {
    expect(withStubGh("echo '[]'", (env) => openPullRequests(repo, env))).toEqual(new Set());
  });
});
