/**
 * Where every issue branch stands, and what it still owes.
 *
 *   pnpm run flow                       # against feat/kb-truthfulness
 *   PA_FLOW_BASE=main pnpm run flow     # once the integration branch has landed
 *
 * Two issues once came to share one branch with no pull request and no tracker
 * record, because a change of priority mid-issue was treated as licence to leave
 * the current one unlanded. The rule against that was written down, and then
 * broken again within the hour by whoever wrote it — so this exists as well.
 *
 * A command rather than a git hook, deliberately. The mistake is `checkout -b`
 * from the wrong place, which no hook observes, and a hook rejecting a commit
 * would fire long after the branch was mis-cut. What was missing at the moment
 * it mattered was an answer to "where am I, and what is owed".
 *
 * What it cannot see, so that nobody trusts it for these:
 *
 *   - work on a detached HEAD, including mid-rebase, since it reads refs and will
 *     report the state from before the rebase began;
 *   - a fork point that was rewritten. Amending or rebasing the commit a branch
 *     was cut from leaves nothing in the graph relating the two, and a commit held
 *     under the same title on both is reported but never failed: two people
 *     writing `wip`, or both reverting one base commit, produce it too;
 *   - a branch merged by squash, whose commits stay unreachable from the base, so
 *     it keeps reporting debt it has already paid, and can read as a stack;
 *   - anything in a shallow clone, where the history that would relate two
 *     branches is not in the object store for git to answer from;
 *   - which branch of an entangled pair was cut from the other, when neither is
 *     an ancestor of the other any more;
 *   - whether a branch was cut from the base or from a third branch the base has
 *     since caught up with. Nothing distinguishes them, so no line claims a base.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * A branch named for an issue: `57b-300`, and the older `57b-222-some-words`,
 * which is covered so that naming a branch that way does not hide it from this
 * check. The team prefix begins with digits here, so a letter is required
 * somewhere in it rather than first; a description must begin with a letter, or
 * `mvp-6-10-review-fixes` reads as issue MVP-6.
 */
const ISSUE_BRANCH = /^(?<team>[0-9]*[a-z][a-z0-9]*)-(?<number>\d+)(?:-[a-z][a-z0-9-]*)?$/i;

/** A name that was reaching for an issue and missed: `57b-85-2`, `57b_86`. */
const NEARLY_AN_ISSUE_BRANCH = /[a-z][-_]?\d/i;

/**
 * The identifiers a subject names before its colon. This repository writes
 * `57B-256, 57B-257: …` where one commit delivers two issues, once wrote
 * `57B-235, 236, 237: …`, and once contracted a pair to `57B-248/250`, which is
 * why a bare number inherits the first identifier's team and why both separators
 * are read.
 */
const SUBJECT_ISSUES = /^[0-9]*[a-z][a-z0-9]*-\d+(?:\s*[,/]\s*(?:[0-9]*[a-z][a-z0-9]*-)?\d+)*$/i;

/** The branch issue branches are cut from, and the one they merge into. */
export const DEFAULT_BASE = "feat/kb-truthfulness";

/** What git can tell us about one issue branch, before any judgement. */
export interface BranchFacts {
  readonly name: string;
  readonly commitSubjects: readonly string[];
  /** Unlanded branches this one is provably built on. */
  readonly builtOn: readonly string[];
  /**
   * Branches holding unlanded commits in common, where ancestry no longer says
   * which was cut from which — either has committed again since.
   */
  readonly entangledWith: readonly string[];
  /** Branches for other issues standing on this exact commit. */
  readonly sameCommitAs: readonly string[];
  /**
   * Remote branches for other issues holding this one's commits: they were cut
   * from it. Reported and not failed, because the branch cut *from* is not the one
   * at fault, and the branch that is has no local ref to report on.
   */
  readonly cutFromThis: readonly string[];
  /**
   * Branches holding an unlanded commit with the same subject. The last signal
   * left when a fork point was rewritten: the graph relates the two branches no
   * longer, but the copy of the commit the child holds still carries its title.
   */
  readonly sharesSubjectsWith: readonly string[];
  /** `null` when `gh` could not be asked, which is not the same as no PR. */
  readonly hasPullRequest: boolean | null;
  /** Base commits this branch does not have, which is how far back it was cut. */
  readonly commitsBehindBase: number;
  /** Nothing of its own beyond the base: merged, freshly cut, stale or reset. */
  readonly behindBase: boolean;
}

export interface Assessment {
  readonly report: readonly string[];
  /** Conditions the roadmap forbids. Non-empty means a non-zero exit. */
  readonly problems: readonly string[];
  /** Branches carrying commits that no pull request covers. */
  readonly owed: readonly string[];
}

/** Everything read from git, so that judgement can be tested without a repository. */
export interface GitState {
  readonly base: string;
  /** False where the base is a tag, a SHA, or a remote ref, which is worth saying. */
  readonly baseIsLocalBranch: boolean;
  /** Local issue branches, the only ones reported on. */
  readonly names: readonly string[];
  /**
   * Names not read as issue branches but holding unlanded work, so that a
   * prefixed or mistyped name is visible rather than silently out of scope.
   */
  readonly unread: readonly string[];
  readonly tip: ReadonlyMap<string, string>;
  readonly subjectsSinceBase: ReadonlyMap<string, readonly string[]>;
  /**
   * `rev-list <base>..<name>` per branch, remote peers included: every commit it
   * holds that the base does not.
   *
   * Two branches are entangled exactly when these sets meet, which replaced a
   * pairwise `merge-base` per pair — 2,200 subprocesses and 28 seconds on this
   * repository, for a command meant to be run before every branch is cut. It also
   * removed the need to reason about which merge base git would pick.
   */
  readonly unlandedCommits: ReadonlyMap<string, readonly string[]>;
  /** `rev-list --count <name>..<base>`: base commits the branch does not have. */
  readonly missingFromBase: ReadonlyMap<string, number>;
  /** Names compared against, which includes remote refs never reported on. */
  readonly peers: readonly string[];
  readonly pullRequests: ReadonlySet<string> | null;
}

/** Which issue a local branch is named for, and nothing prefixed counts. */
export function issueOf(branch: string): string | null {
  const groups = ISSUE_BRANCH.exec(branch)?.groups;
  return groups === undefined ? null : `${groups.team}-${groups.number}`.toUpperCase();
}

/**
 * Which issue a name refers to, prefix and all: `origin/57b-300` refers to the
 * same issue as `57b-300`, or a remote copy of a branch would be compared against
 * the branch itself and reported as another issue's work.
 *
 * Kept apart from `issueOf` because which branches are *read* must stay strict —
 * reading prefixed names would claim ten spent `feat/mvp-*` branches as issues.
 */
export function issueReferredToBy(name: string): string | null {
  return issueOf(name.includes("/") ? (name.split("/").pop() ?? name) : name);
}

export function issuesNamedBy(subject: string): readonly string[] {
  const prefix = subject.split(":")[0]?.trim() ?? "";
  if (!SUBJECT_ISSUES.test(prefix)) return [];
  const team = /^([0-9]*[a-z][a-z0-9]*)-/i.exec(prefix)![1]!.toUpperCase();
  return prefix
    .split(/[,/]/)
    .map((part) => part.trim().toUpperCase())
    .map((part) => (part.includes("-") ? part : `${team}-${part}`));
}

/** The base to compare against, which stops naming a branch that no longer exists. */
export function baseFrom(env: Readonly<Record<string, string | undefined>>): string {
  const named = env.PA_FLOW_BASE?.trim();
  return named === undefined || named === "" ? DEFAULT_BASE : named;
}

/** Turns what git said into what it means. Every subtlety below was once a defect. */
export function deriveFacts(state: GitState): readonly BranchFacts[] {
  const held = (name: string): ReadonlySet<string> => new Set(state.unlandedCommits.get(name) ?? []);

  return state.names.map((name) => {
    const tip = state.tip.get(name);
    const mineCommits = held(name);
    // Two branches for one issue are one piece of work, not the mistake: this
    // repository already carries three for 57B-246.
    const otherIssue = (other: string): boolean =>
      other !== name && issueReferredToBy(other) !== issueReferredToBy(name);
    // Ancestry, without asking git a second time: a branch is behind this one when
    // the commit it points at is one this branch holds. A landed branch holds
    // nothing unlanded, so it can never be read as a base — which is the defect
    // the first version had, and the reason plain `--is-ancestor` was wrong.
    const behind = (of: string, other: string): boolean => {
      const otherTip = state.tip.get(other);
      return otherTip !== undefined && held(of).has(otherTip);
    };

    const shared = state.peers.filter(
      (other) => otherIssue(other) && [...held(other)].some((commit) => mineCommits.has(commit)),
    );
    const sameCommit = shared.filter((other) => tip !== undefined && state.tip.get(other) === tip);
    const apart = shared.filter((other) => !sameCommit.includes(other));
    const ancestors = new Set(apart.filter((other) => behind(name, other)));
    // A branch that was cut from is not built on what was cut from it.
    const descendant = (other: string): boolean => behind(other, name);

    // Amending or rebasing the commit a branch was cut from leaves the child
    // holding a copy that exists nowhere else, and no shared commit for the graph
    // to find. The copy keeps its subject, which is the only thing left to notice.
    const mine = new Set(state.subjectsSinceBase.get(name) ?? []);
    const sharesSubjects = state.peers.filter(
      (other) =>
        otherIssue(other) &&
        !shared.includes(other) &&
        (state.subjectsSinceBase.get(other) ?? []).some((subject) => mine.has(subject)),
    );

    return {
      name,
      commitSubjects: state.subjectsSinceBase.get(name) ?? [],
      builtOn: apart.filter((other) => ancestors.has(other)),
      entangledWith: apart.filter((other) => !ancestors.has(other) && !descendant(other)),
      sameCommitAs: sameCommit,
      cutFromThis: apart.filter((other) => other.includes("/") && descendant(other)),
      sharesSubjectsWith: sharesSubjects,
      hasPullRequest: state.pullRequests === null ? null : state.pullRequests.has(name),
      commitsBehindBase: state.missingFromBase.get(name) ?? 0,
      behindBase: mineCommits.size === 0,
    };
  });
}

export function assess(branches: readonly BranchFacts[], base = DEFAULT_BASE): Assessment {
  const report: string[] = [];
  const problems: string[] = [];
  const owed: string[] = [];

  // Branches holding nothing of their own are counted rather than listed: on this
  // repository they outnumber the live ones and buried them. Which of them merged
  // and which was cut a minute ago is not in the graph, so neither is claimed.
  const quiet = branches.filter((b) => b.behindBase);
  if (quiet.length > 0) {
    report.push(
      `${quiet.length} holding nothing beyond ${base}, merged or just cut: ${quiet
        .map((b) => b.name)
        .join(", ")}`,
    );
  }

  for (const branch of branches) {
    if (branch.behindBase) continue;
    const issue = issueOf(branch.name) ?? branch.name;
    report.push(`${branch.name}  (${issue})`);

    // One problem per pair, stated by the earlier name. A remote peer gets no
    // iteration of its own, so waiting for it to state the pair stated it never:
    // with a team prefix sorting after `o`, remote entanglement exited zero.
    const first = (peer: string): boolean => peer.includes("/") || branch.name < peer;

    if (branch.builtOn.length > 0) {
      const stack = branch.builtOn.join(", ");
      report.push(`  built on   ${stack}  <- an unlanded issue branch`);
      problems.push(`${branch.name} is built on ${stack} rather than ${base}`);
    }
    if (branch.entangledWith.length > 0) {
      // Ancestry stops holding the moment either branch commits again, and never
      // held for a parent only the remote has. Shared unlanded commits survive
      // both, at the cost of not saying which way round the pair is.
      report.push(`  shares unlanded commits with ${branch.entangledWith.join(", ")}`);
      const unstated = branch.entangledWith.filter(first);
      if (unstated.length > 0) {
        // Not "one was cut from the other": both may have been cut from a third
        // branch, which happens when the base is set to the wrong integration
        // branch. What is certain is the unlanded work they hold in common.
        problems.push(
          `${branch.name} holds unlanded commits also on ${unstated.join(", ")}, which is another issue's branch`,
        );
      }
    }
    if (branch.sameCommitAs.length > 0) {
      report.push(`  stands on the same commit as ${branch.sameCommitAs.join(", ")}`);
      const unstated = branch.sameCommitAs.filter(first);
      if (unstated.length > 0) {
        problems.push(
          `${branch.name} stands on the same commit as ${unstated.join(", ")}, which is another issue's work`,
        );
      }
    }
    if (branch.cutFromThis.length > 0) {
      report.push(`  ${branch.cutFromThis.join(", ")} holds this branch's commits, so it was cut from it`);
    }
    if (branch.sharesSubjectsWith.length > 0) {
      // Reported, never failed. It fires exactly where the graph shows nothing,
      // so it cannot tell a rewritten fork point from two people writing `wip` —
      // and `Revert "<a base commit>"` is a subject git composes identically on
      // any branch that reverts it. A reader can tell which; this cannot.
      report.push(`  holds a commit titled the same as one on ${branch.sharesSubjectsWith.join(", ")}`);
    }
    if (
      branch.builtOn.length +
        branch.entangledWith.length +
        branch.sameCommitAs.length +
        branch.cutFromThis.length +
        branch.sharesSubjectsWith.length ===
      0
    ) {
      // Never "based on the base": a branch cut from a third branch the base has
      // caught up with is indistinguishable from one cut from the base, and the
      // report used to assert the base whenever nothing contradicted it. Distance
      // is checkable; being behind is not a failure, since the base gains a commit
      // every time another issue lands.
      report.push(
        branch.commitsBehindBase === 0
          ? `  up to date with ${base}`
          : `  ${branch.commitsBehindBase} commit(s) behind ${base}`,
      );
    }

    const state =
      branch.hasPullRequest === null
        ? "PR unknown, gh did not answer"
        : branch.hasPullRequest
          ? "PR open"
          : branch.commitSubjects.length === 0
            ? "nothing to land yet"
            : "no PR";
    report.push(`  carries    ${branch.commitSubjects.length} commit(s) beyond ${base}, ${state}`);

    const foreign = new Map<string, number>();
    let unattributed = 0;
    for (const subject of branch.commitSubjects) {
      const named = issuesNamedBy(subject);
      if (named.length === 0) {
        unattributed += 1;
        continue;
      }
      if (named.includes(issue)) continue;
      report.push(`  x commit names ${named.join(", ")}: ${subject}`);
      for (const other of named) foreign.set(other, (foreign.get(other) ?? 0) + 1);
    }
    for (const [other, count] of foreign) {
      problems.push(`${branch.name} carries ${count} commit(s) for ${other}`);
    }
    // Counted, never failed: a subject naming no issue is ordinary in progress,
    // and it is also what a branch cut from somewhere else is full of.
    if (unattributed > 0) report.push(`  ${unattributed} commit(s) name no issue`);

    if (branch.commitSubjects.length > 0 && branch.hasPullRequest === false) owed.push(branch.name);
  }

  return { report, problems, owed };
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function resolves(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open pull requests by head branch, or `null` when `gh` could not answer —
 * missing, unauthenticated or offline. An empty set would state that no branch
 * has a pull request, which is a different claim from not having asked.
 */
export function openPullRequests(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | null {
  try {
    const json = execFileSync("gh", ["pr", "list", "--state", "open", "--json", "headRefName"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set((JSON.parse(json) as { headRefName: string }[]).map((pr) => pr.headRefName));
  } catch {
    return null;
  }
}

/** Commit subjects, kept one per commit even where a commit has no subject at all. */
function subjectsIn(cwd: string, range: string): readonly string[] {
  const log = git(cwd, "log", "--format=%H%x09%s", range);
  if (log === "") return [];
  return log.split("\n").map((line) => line.slice(line.indexOf("\t") + 1));
}

export function readGit(
  base: string,
  cwd: string = process.cwd(),
  pullRequests: (cwd: string) => ReadonlySet<string> | null = openPullRequests,
): GitState {
  // Fully qualified throughout: a tag sharing a branch's name wins `rev-parse`,
  // and every fact about the branch then came from the tag instead. The base too —
  // a tag named `feat/kb-truthfulness` hid a real stack, and git said so in a
  // warning nobody read.
  const local = git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean);
  const remote = git(cwd, "for-each-ref", "--format=%(refname)", "refs/remotes")
    .split("\n")
    .filter(Boolean);
  const short = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, "");
  const names = local.filter((ref) => issueOf(short(ref)) !== null).map(short);
  const ref = (name: string): string => (local.includes(`refs/heads/${name}`) ? `refs/heads/${name}` : name);
  const baseRef = ref(base);

  // One read per branch rather than a comparison per pair: the sets say both what
  // a branch holds and, by meeting, which branches are entangled.
  const unlandedIn = (candidate: string): readonly string[] =>
    git(cwd, "rev-list", `${baseRef}..${candidate}`).split("\n").filter(Boolean);

  // A parent that exists only on the remote is still the branch this one was cut
  // from, and reading heads alone missed it entirely. Remote peers are compared
  // against and never reported on; a remote copy of a local branch is the same
  // issue, so it is excluded by the same-issue rule in `deriveFacts`.
  const remotePeers = remote.filter((r) => issueReferredToBy(short(r)) !== null);
  // Kept fully qualified: a tag named `origin/57b-70` would otherwise win
  // `rev-parse` and mislabel which branch was cut from which.
  const at = new Map<string, string>([
    ...names.map((name): [string, string] => [name, ref(name)]),
    ...remotePeers.map((r): [string, string] => [short(r), r]),
  ]);
  const unlanded = new Map<string, readonly string[]>(
    [...at.entries()].map(([name, full]) => [name, unlandedIn(full)]),
  );
  // Landed remote refs are dropped: they can share nothing unlanded, and this
  // repository has 66 of them.
  const peers = [...unlanded.entries()].filter(([, commits]) => commits.length > 0).map(([name]) => name);

  return {
    base,
    baseIsLocalBranch: baseRef.startsWith("refs/heads/"),
    names,
    unread: local
      .map(short)
      .filter(
        (name) =>
          issueOf(name) === null &&
          NEARLY_AN_ISSUE_BRANCH.test(name) &&
          unlandedIn(`refs/heads/${name}`).length > 0,
      ),
    tip: new Map([...at.entries()].map(([name, full]) => [name, git(cwd, "rev-parse", full)])),
    subjectsSinceBase: new Map(names.map((name) => [name, subjectsIn(cwd, `${baseRef}..${ref(name)}`)])),
    unlandedCommits: unlanded,
    missingFromBase: new Map(
      names.map((name) => [name, Number(git(cwd, "rev-list", "--count", `${ref(name)}..${baseRef}`))]),
    ),
    peers,
    pullRequests: pullRequests(cwd),
  };
}

export function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): number {
  const base = baseFrom(env);
  if (!resolves(cwd, base)) {
    err(
      `No branch "${base}" here. Issue branches are cut from it, so there is nothing to compare ` +
        "against. Set PA_FLOW_BASE to the branch that plays that part.",
    );
    return 1;
  }

  const state = readGit(base, cwd);
  if (!state.baseIsLocalBranch) {
    // A tag left behind by a deleted branch of the same name reads as the base,
    // and every distance is then measured from the tag in silence.
    out(`"${base}" is not a local branch here; distances are measured from whatever it resolves to.`);
  }
  const { report, problems, owed } = assess(deriveFacts(state), base);
  out(state.names.length === 0 ? "No issue branches." : report.join("\n"));

  // Printed even when nothing was read, or work behind an unread name would be
  // invisible under a report that says there is none.
  if (state.unread.length > 0) {
    out(`\nHolding work, and not read as an issue branch: ${state.unread.join(", ")}.`);
  }
  if (owed.length > 0) {
    out(`\nCommits with no pull request: ${owed.join(", ")}. An issue is not done until it lands.`);
  }
  if (problems.length > 0) {
    err(`\n${problems.length} state(s) the roadmap forbids:`);
    for (const problem of problems) err(`  - ${problem}`);
    err(`An issue branch is cut from ${base} and carries only its own commits.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
