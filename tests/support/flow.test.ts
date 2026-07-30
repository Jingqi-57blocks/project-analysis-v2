import { describe, expect, it } from "vitest";

import {
  assess,
  baseFrom,
  deriveFacts,
  issueOf,
  issuesNamedBy,
  type BranchFacts,
  type GitState,
} from "../../scripts/flow.js";

const BASE = "feat/kb-truthfulness";

function branch(overrides: Partial<BranchFacts> & { name: string }): BranchFacts {
  return {
    commitSubjects: [],
    builtOn: [],
    entangledWith: [],
    sameCommitAs: [],
    cutFromThis: [],
    sharesSubjectsWith: [],
    hasPullRequest: false,
    commitsBehindBase: 0,
    behindBase: false,
    ...overrides,
  };
}

/**
 * A repository shape, stated the way git reports it. Each branch names the commits
 * it holds that the base does not, because that is what git is asked for and what
 * every relation between two branches is derived from.
 */
function state(
  branches: readonly {
    name: string;
    tip: string;
    holds?: readonly string[];
    subjects?: readonly string[];
    missingFromBase?: number;
  }[],
  pullRequests: ReadonlySet<string> | null = new Set(),
  /** Compared against but never reported on, which is what a remote ref is. */
  alsoPresent: readonly { name: string; tip: string; holds?: readonly string[] }[] = [],
): GitState {
  const all = [...branches, ...alsoPresent];
  return {
    base: BASE,
    baseIsLocalBranch: true,
    unread: [],
    names: branches.map((b) => b.name),
    peers: all.map((b) => b.name),
    tip: new Map(all.map((b) => [b.name, b.tip])),
    subjectsSinceBase: new Map(branches.map((b) => [b.name, b.subjects ?? []])),
    // A branch holding its own tip and nothing else is the ordinary case.
    unlandedCommits: new Map(all.map((b) => [b.name, b.holds ?? [b.tip]])),
    missingFromBase: new Map(branches.map((b) => [b.name, b.missingFromBase ?? 0])),
    pullRequests,
  };
}

describe("which branches are issue branches", () => {
  it("reads the issue a branch is named for", () => {
    expect(issueOf("57b-300")).toBe("57B-300");
  });

  it("reads one named with a description too, so that form cannot hide", () => {
    // Six branches in this repo are named `57b-222-datamodel-records`. Matching
    // only the bare form would let a mis-cut branch escape the check by having a
    // few words after its number.
    expect(issueOf("57b-222-datamodel-records")).toBe("57B-222");
  });

  it("does not read a second number as a description", () => {
    // `mvp-6-10-review-fixes` exists on the remote and is a range, not issue
    // MVP-6. Read as an issue branch it failed the check with a commit for an
    // issue it was never named for, and nothing its author could do about it.
    expect(issueOf("mvp-6-10-review-fixes")).toBeNull();
  });

  it("leaves everything else alone", () => {
    // The integration branch and `main` are not issue branches, and a number on
    // both sides of the dash names no team.
    for (const name of ["main", BASE, "feat/mvp-10-templates", "release", "12-34"]) {
      expect(issueOf(name)).toBeNull();
    }
  });
});

describe("which issues a commit subject names", () => {
  it("reads one", () => {
    expect(issuesNamedBy("57B-300: a check that refuses the mistake")).toEqual(["57B-300"]);
  });

  it("reads every identifier a subject names, not only the first", () => {
    // 13 commits in this repo deliver two issues at once, and one names five.
    // Reading only the first failed `57b-215` for carrying 57B-214's commit,
    // which is the same commit.
    expect(issuesNamedBy("57B-256, 57B-257: fixes from two reviews")).toEqual(["57B-256", "57B-257"]);
    expect(issuesNamedBy("57B-235, 236, 237, 238, 239: documents")).toEqual([
      "57B-235",
      "57B-236",
      "57B-237",
      "57B-238",
      "57B-239",
    ]);
  });

  it("does not read a subject that only begins like an identifier", () => {
    // Without an end anchor on the list, `57B-300 fix: …` read as an issue called
    // `57B-300 FIX`, which no branch is named for, so a branch's own commit would
    // have been reported as another issue's.
    expect(issuesNamedBy("57B-300 fix: a thing")).toEqual([]);
    expect(issuesNamedBy("57B-300 and 57B-301: two things")).toEqual([]);
  });

  it("reads a contracted pair, which links only the first identifier in the tracker", () => {
    // CLAUDE.md records `57B-248/250` happening once, and 57B-256 silently
    // vanishing from the board as a result.
    expect(issuesNamedBy("57B-248/250: two issues, contracted")).toEqual(["57B-248", "57B-250"]);
  });

  it("names nothing where a subject names no issue", () => {
    // Demanding one would fail every branch holding a merge, a revert or a
    // work-in-progress commit.
    for (const subject of [
      "Merge pull request #35 from Jingqi-57blocks/feat",
      'Revert "57B-300: a check"',
      "fixup! 57B-300: a check",
      "wip",
    ]) {
      expect(issuesNamedBy(subject)).toEqual([]);
    }
  });
});

describe("reading what git said", () => {
  it("does not read a landed branch as the base of what came after it", () => {
    // Every merged branch is an ancestor of everything cut afterwards, so plain
    // ancestry made all three live branches fail against seven merged ones. A
    // landed branch holds no unlanded commit, so it can meet nothing.
    const facts = deriveFacts(
      state([
        { name: "57b-253", tip: "landed", holds: [] },
        { name: "57b-300", tip: "own", holds: ["own"], subjects: ["57B-300: a check"] },
      ]),
    );
    const own = facts.find((f) => f.name === "57b-300")!;
    expect([...own.builtOn, ...own.entangledWith]).toEqual([]);
    expect(facts.find((f) => f.name === "57b-253")!.behindBase).toBe(true);
  });

  it("reads the unlanded branch a stack sits on, and which way round it is", () => {
    const facts = deriveFacts(
      state([
        { name: "57b-278", tip: "spec", holds: ["spec"], subjects: ["57B-278: a spec"] },
        { name: "57b-293", tip: "table", holds: ["table", "spec"], subjects: ["57B-293: a table"] },
      ]),
    );
    expect(facts.find((f) => f.name === "57b-293")!.builtOn).toEqual(["57b-278"]);
    // And the branch it was cut from is not accused of the reverse.
    expect(facts.find((f) => f.name === "57b-278")!.builtOn).toEqual([]);
  });

  it("finds a pair whose shared commit no longer says which came first", () => {
    // The mistake's real shape: a branch is cut from an unlanded one, and that one
    // commits again. Neither tip is in the other's history any more, and detection
    // by ancestry alone exited zero — the defect the second review found.
    const facts = deriveFacts(
      state([
        { name: "57b-100", tip: "parent-2", holds: ["parent-2", "parent-1"] },
        { name: "57b-101", tip: "child", holds: ["child", "parent-1"] },
      ]),
    );
    expect(facts.map((f) => f.builtOn)).toEqual([[], []]);
    expect(facts.map((f) => f.entangledWith)).toEqual([["57b-101"], ["57b-100"]]);
  });

  it("does not accuse a parent of being built on its own child", () => {
    // Meeting is mutual, so the branch that was cut from and the one cut from it
    // each reported the other, and a legitimate parent failed too.
    const facts = deriveFacts(
      state([
        { name: "57b-210", tip: "parent", holds: ["parent"] },
        { name: "57b-211", tip: "child", holds: ["child", "parent"] },
      ]),
    );
    const parent = facts.find((f) => f.name === "57b-210")!;
    expect([...parent.builtOn, ...parent.entangledWith]).toEqual([]);
  });

  it("does not entangle two branches for the same issue", () => {
    // This repository already has three branches for 57B-246, each cut from the
    // last. A follow-up branch for one issue is one piece of work, and failing it
    // would fail legitimate work.
    const facts = deriveFacts(
      state([
        { name: "57b-246-part-one", tip: "one", holds: ["one"] },
        { name: "57b-246-part-two", tip: "two", holds: ["two", "one"] },
      ]),
    );
    expect(facts.flatMap((f) => [...f.builtOn, ...f.entangledWith, ...f.sameCommitAs])).toEqual([]);
  });

  it("reads two names for one commit as two names, not as a base", () => {
    // `git branch 57b-999 57b-278` makes each an ancestor of the other, and the
    // legitimate branch was accused of being stacked on its own copy. Standing on
    // another issue's commit is its own problem, stated as itself.
    const facts = deriveFacts(
      state([
        { name: "57b-278", tip: "same", holds: ["same"] },
        { name: "57b-999", tip: "same", holds: ["same"] },
      ]),
    );
    expect(facts.flatMap((f) => [...f.builtOn, ...f.entangledWith])).toEqual([]);
    expect(facts.map((f) => f.sameCommitAs)).toEqual([["57b-999"], ["57b-278"]]);
  });

  it("compares against a branch only the remote has, and not against its own copy", () => {
    // A parent pushed and then deleted locally was never compared against at all.
    // Its own remote copy shares everything with it, and comparing the two would
    // fail every pushed branch against itself.
    const facts = deriveFacts(
      state([{ name: "57b-71", tip: "child", holds: ["child", "parent"] }], new Set(), [
        { name: "origin/57b-70", tip: "parent", holds: ["parent"] },
        { name: "origin/57b-71", tip: "child", holds: ["child", "parent"] },
      ]),
    );
    expect(facts[0]!.builtOn).toEqual(["origin/57b-70"]);
    expect(facts[0]!.sameCommitAs).toEqual([]);
    expect(facts).toHaveLength(1);
  });

  it("names a remote branch that was cut from this one, which has no turn of its own", () => {
    // The branch cut from is not the one at fault, and the one that is has no local
    // ref to report on, so the pair went unmentioned entirely.
    const facts = deriveFacts(
      state([{ name: "57b-90", tip: "own", holds: ["own"], subjects: ["57B-90: work"] }], new Set(), [
        { name: "origin/57b-91", tip: "theirs", holds: ["theirs", "own"] },
      ]),
    );
    expect(facts[0]!.cutFromThis).toEqual(["origin/57b-91"]);
    expect(facts[0]!.builtOn).toEqual([]);
    const { problems, report } = assess(facts);
    expect(problems).toEqual([]);
    expect(report.join("\n")).toContain("origin/57b-91 holds this branch's commits");
  });

  it("reports a pull request as unknown where gh could not be asked", () => {
    const facts = deriveFacts(state([{ name: "57b-300", tip: "aaa" }], null));
    expect(facts[0]!.hasPullRequest).toBeNull();
  });

  it("carries how many of the base's commits the branch does not have", () => {
    const facts = deriveFacts(
      state([
        { name: "57b-403", tip: "aaa", missingFromBase: 4 },
        { name: "57b-404", tip: "bbb" },
      ]),
    );
    expect(facts.map((f) => f.commitsBehindBase)).toEqual([4, 0]);
  });

  it("notices a commit title held on two issues' branches", () => {
    // All that a rewritten fork point leaves behind: the branches share no commit,
    // and the copy the child holds still carries its title.
    const facts = deriveFacts(
      state([
        { name: "57b-50", tip: "amended", holds: ["amended"], subjects: ["wip on the parent"] },
        {
          name: "57b-51",
          tip: "child",
          holds: ["child", "original"],
          subjects: ["57B-51: child work", "wip on the parent"],
        },
      ]),
    );
    expect(facts.map((f) => f.entangledWith)).toEqual([[], []]);
    expect(facts.map((f) => f.sharesSubjectsWith)).toEqual([["57b-51"], ["57b-50"]]);
  });
});

describe("which base to compare against", () => {
  it("uses the integration branch by default", () => {
    expect(baseFrom({})).toBe(BASE);
  });

  it("takes the one the environment names, for the day the default is gone", () => {
    // `feat/kb-truthfulness` merges to `main` once and then stops existing, at
    // which point every branch would be measured against nothing.
    expect(baseFrom({ PA_FLOW_BASE: "main" })).toBe("main");
  });

  it("ignores an empty setting rather than comparing against nothing", () => {
    expect(baseFrom({ PA_FLOW_BASE: "" })).toBe(BASE);
    expect(baseFrom({ PA_FLOW_BASE: "  " })).toBe(BASE);
  });
});

describe("the states the roadmap forbids", () => {
  it("fails a branch cut from an unlanded issue branch", () => {
    // The mistake itself: 57B-293's work went onto 57B-278's branch while
    // 57B-278 had no pull request.
    const { problems } = assess([
      branch({ name: "57b-278", commitSubjects: ["57B-278: render the recovered PRD"] }),
      branch({
        name: "57b-293",
        commitSubjects: ["57B-293: attribute a table"],
        builtOn: ["57b-278"],
      }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("57b-293 is built on 57b-278");
  });

  it("says how far behind the base a branch is, and never claims a base", () => {
    // The base was asserted whenever nothing contradicted it, so a branch cut
    // from `main` was reported as based on a branch it had never seen — and a
    // branch cut from a third branch the base has caught up with is
    // indistinguishable from one cut from the base. Distance is checkable.
    // Failing a branch for being behind would fail every branch in the repository
    // the moment another issue landed, which is how a check gets deleted.
    const { problems, report } = assess([
      branch({ name: "57b-403", commitsBehindBase: 4, commitSubjects: ["57B-403: a thing"] }),
    ]);
    expect(problems).toEqual([]);
    expect(report.join("\n")).toContain(`4 commit(s) behind ${BASE}`);
    expect(report.join("\n")).not.toContain("based on");
  });

  it("fails a pair sharing unlanded commits where ancestry has stopped holding", () => {
    const { problems, report } = assess([
      branch({ name: "57b-100", entangledWith: ["57b-101"], commitSubjects: ["wip"] }),
      branch({
        name: "57b-101",
        entangledWith: ["57b-100"],
        commitSubjects: ["wip", "57B-101: child work"],
      }),
    ]);
    // One state, not two, and neither branch's line claims the base.
    expect(problems).toEqual([
      "57b-100 holds unlanded commits also on 57b-101, which is another issue's branch",
    ]);
    expect(report.join("\n")).not.toContain(`based on   ${BASE}`);
  });

  it("reports a commit title held twice without failing either branch", () => {
    // The last trace of a rewritten fork point, and also what two people writing
    // `wip` produce, and what git writes on its own when two branches revert one
    // base commit. It fires only where the graph shows nothing, so it cannot tell
    // those apart — a reader can, and the exit code must not pretend to.
    const { problems, report } = assess([
      branch({ name: "57b-50", sharesSubjectsWith: ["57b-51"], commitSubjects: ["wip"] }),
      branch({ name: "57b-51", sharesSubjectsWith: ["57b-50"], commitSubjects: ["wip", "57B-51: work"] }),
    ]);
    expect(problems).toEqual([]);
    expect(report.join("\n")).toContain("holds a commit titled the same as one on 57b-51");
  });

  it("states a pair with a remote peer, which gets no turn of its own", () => {
    // `first` waited for the later name to state the pair. A remote peer is
    // compared against and never iterated, so with a team prefix sorting after
    // `o` the pair was reported and then passed.
    const { problems } = assess([
      branch({ name: "web-71", entangledWith: ["origin/web-70"], commitSubjects: ["WEB-71: work"] }),
    ]);
    expect(problems).toEqual([
      "web-71 holds unlanded commits also on origin/web-70, which is another issue's branch",
    ]);
  });

  it("states a pair once where both halves are local", () => {
    const { problems } = assess([
      branch({ name: "57b-100", entangledWith: ["57b-101"], commitSubjects: ["57B-100: work"] }),
      branch({ name: "57b-101", entangledWith: ["57b-100"], commitSubjects: ["57B-101: work"] }),
    ]);
    expect(problems).toHaveLength(1);
  });

  it("fails a branch carrying a commit for another issue", () => {
    const { problems } = assess([
      branch({ name: "57b-300", commitSubjects: ["57B-299: tell a rejection from a nearby string"] }),
    ]);
    expect(problems).toEqual(["57b-300 carries 1 commit(s) for 57B-299"]);
  });

  it("states one problem per foreign issue, however many commits it has", () => {
    const { problems } = assess([
      branch({
        name: "57b-300",
        commitSubjects: ["57B-278: a recovered specification", "57B-278: fixes from review"],
      }),
    ]);
    expect(problems).toEqual(["57b-300 carries 2 commit(s) for 57B-278"]);
  });

  it("accepts a commit that delivers this issue alongside another", () => {
    // Whichever position the branch's own issue holds in the subject's list.
    for (const name of ["57b-256", "57b-257"]) {
      const { problems } = assess([
        branch({ name, commitSubjects: ["57B-256, 57B-257: fixes from two reviews"] }),
      ]);
      expect(problems).toEqual([]);
    }
  });

  it("counts commits that name no issue without calling them a problem", () => {
    // Ordinary in progress, and also what a branch cut from somewhere else is
    // full of, so it is reported and never failed.
    const { problems, report } = assess([
      branch({ name: "57b-300", commitSubjects: ["wip", "Merge branch 'main' into 57b-300"] }),
    ]);
    expect(problems).toEqual([]);
    expect(report.join("\n")).toContain("2 commit(s) name no issue");
  });

  it("still names another issue's commits on a branch cut from the wrong place", () => {
    // Commits are counted from where the branch left the base, so what appears
    // here is what the branch really carries — and a branch holding another
    // issue's commit is the failure whether or not its base was right.
    const { problems, report } = assess([
      branch({
        name: "57b-404",
        commitsBehindBase: 2,
        commitSubjects: ["57B-100: something that landed on main", "57B-404: its own work"],
      }),
    ]);
    expect(problems).toEqual(["57b-404 carries 1 commit(s) for 57B-100"]);
    expect(report.join("\n")).toContain(`2 commit(s) behind ${BASE}`);
  });

  it("passes a branch cut from the base with its own commits", () => {
    const { problems, report } = assess([
      branch({ name: "57b-300", commitSubjects: ["57B-300: a check that refuses the mistake"] }),
    ]);
    expect(problems).toEqual([]);
    expect(report.join("\n")).toContain(`up to date with ${BASE}`);
  });

  it("names the base it was given rather than the default", () => {
    // Once the integration branch merges to `main` it stops existing, and every
    // message that named it would be wrong.
    const { report } = assess([branch({ name: "57b-300", commitSubjects: ["57B-300: a check"] })], "main");
    expect(report.join("\n")).toContain("up to date with main");
  });
});

describe("what a branch still owes", () => {
  it("names a branch whose commits no pull request covers", () => {
    const { owed, problems } = assess([
      branch({ name: "57b-293", commitSubjects: ["57B-293: attribute a table"] }),
    ]);
    expect(owed).toEqual(["57b-293"]);
    // Owed is a reminder, not a failure — a branch is unpushed for a while in
    // the ordinary course of finishing it.
    expect(problems).toEqual([]);
  });

  it("owes nothing once a pull request is open, or before any commit exists", () => {
    const { owed } = assess([
      branch({ name: "57b-293", commitSubjects: ["57B-293: a table"], hasPullRequest: true }),
      branch({ name: "57b-300" }),
    ]);
    expect(owed).toEqual([]);
  });

  it("claims nothing about a pull request it could not ask about", () => {
    // An empty answer from a missing `gh` was reported as no pull request
    // existing, which is a different claim from not having asked.
    const { owed, report } = assess([
      branch({ name: "57b-293", commitSubjects: ["57B-293: a table"], hasPullRequest: null }),
    ]);
    expect(owed).toEqual([]);
    expect(report.join("\n")).toContain("PR unknown, gh did not answer");
  });

  it("says a fresh branch has nothing to land rather than that it lacks a PR", () => {
    const { report } = assess([branch({ name: "57b-300" })]);
    expect(report.join("\n")).toContain(`0 commit(s) beyond ${BASE}, nothing to land yet`);
  });

  it("counts branches holding nothing on one line rather than two lines each", () => {
    // Seven of them sit in this repository. Listed individually they buried the
    // two lines that said work was unlanded.
    const { report } = assess([
      branch({ name: "57b-240", behindBase: true }),
      branch({ name: "57b-246-product-report", behindBase: true }),
      branch({ name: "57b-293", commitSubjects: ["57B-293: a table"] }),
    ]);
    expect(report[0]).toBe(
      `2 holding nothing beyond ${BASE}, merged or just cut: 57b-240, 57b-246-product-report`,
    );
    expect(report).toHaveLength(4);
    expect(report.slice(1)).toEqual([
      "57b-293  (57B-293)",
      `  up to date with ${BASE}`,
      `  carries    1 commit(s) beyond ${BASE}, no PR`,
    ]);
  });

  it("does not say which of them merged and which was just cut", () => {
    // A merged branch, one cut a minute ago, a stale leftover and one that was
    // reset are one shape in the graph. Reading the tip commit's subject to
    // separate them called a brand-new follow-up branch merged work — twice, in
    // two different ways — and hid it from the report either way.
    const { report } = assess([
      branch({ name: "57b-301-followup", behindBase: true }),
      branch({ name: "57b-253", behindBase: true }),
    ]);
    expect(report).toEqual([
      `2 holding nothing beyond ${BASE}, merged or just cut: 57b-301-followup, 57b-253`,
    ]);
  });
});
