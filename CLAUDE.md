# Working on this project

Commands, layout and the target-derivation workflow are in [README.md](README.md).
This file is the part that is not obvious from reading the code: the rules that
have already cost us something when broken.

## Read the roadmap first

[ROADMAP.md](ROADMAP.md) is the plan of record until 57B-267 and 57B-275 are
Done. It holds the ordered queue, the phase each issue belongs to, and the
**eight-step definition of done** — of which the last three are opening a PR,
setting the Linear issue to In Review, and merging before the next issue starts.

An issue is not finished when its tests pass. Skipping those three steps is how
two issues came to share one branch with no PR and no Linear record. A change of
priority changes what is worked on next; it never changes what is owed on work
already in hand.

**Run `pnpm run flow` before cutting a branch and before calling an issue done.**
It prints where every issue branch stands and exits non-zero on the two states
this paragraph is about. Writing the rule down did not prevent a second
occurrence within the hour; the check is there because prose was not enough.

## How a change gets reviewed

Review is the **`code-review` plugin workflow**, at **max effort** — not the Sonnet
and Haiku tiers its own file names — with its five passes dispatched concurrently
rather than by one agent in sequence: CLAUDE.md adherence, a diff-only bug scan, git
history of the modified code, **comments on prior PRs that touched these files**, and
**the code comments in those files against what the change now does**.

Those last two are why it replaced the ad-hoc reviewer. Six sequential adversarial
rounds on 57B-278 missed two defects the plugin found at once: a branch returning an
email subject line published as a rule the system enforces — recorded as already
fixed on the sibling code path in PR #57's own comment — and a presentation-value
skip testing the wrong node kind, under a declared limit saying such values could not
appear.

- **Act on P0 and P1 only.** Have the reader report anything from 50 up: the plugin's
  own 80 threshold and its exclusion list ("test coverage", "lines the user did not
  modify", "pre-existing") drop classes that hide real defects here. Report is not
  the same as act.
- **Post every review on the PR**, as comments at the lines they concern, each saying
  where the finding stands — fixed in a named commit, deferred to a named issue, or
  open. A review that lives only in a terminal makes the next reader find it again.
- **Whether to re-review after fixing is a judgement to make and state**, not a
  ritual. A fix that adds a sentence to a document needs its claims measured again; a
  fix already verified against a fresh run of a real target does not need a second
  reader. A third round means the fixes are introducing defects.
- **Measure your own new claims before asking anyone to read them.** Render, and check
  every sentence the change added against the data behind it. Four of the six rounds
  on 57B-278 went on sentences written and never measured — "a dash means nothing
  could be attributed", "established in the handler itself", "every capability is
  stated at equal weight" — each false of the data one command away. State a quantity
  by computing it at render time, or soften the sentence until it is true of any
  input.

## Never change an analyzed project's content

The rule is about the project's **own** files, and only those. Never edit,
delete, reformat, lint, or run `git` inside a target — not a whitespace fix, not
a `git status`. The tool's claim is that what it reports is what was there, and
one modification invalidates that for every run afterwards. It is also
self-defeating: a run that changes a root changes its content digest mid-flight
and refuses to publish, blaming drift it caused itself.

**A code index is not a modification of the project.** The indexer creates a
`.codegraph/` directory in the folder holding the analyzed roots — its own data,
alongside the code, touching none of it. That is expected and fine, it needs no
apology in the docs, and it is not an exception to be engineered away.

Two properties keep it honest, and those are worth defending:

- **It never lands inside an analyzed root** — always the directory above, so no
  repository being analyzed gains a directory. When that directory above is
  itself a repository, as in a monorepo whose packages are the roots,
  `.codegraph/` does show in its `git status` and can be ignored there.
- **Every run says where it is**, on the terminal and in the knowledge base, and
  says so from the filesystem rather than from its own intention.

Where it goes is not configurable, and asking for that is a dead end: the indexer
stores its database inside whatever directory it indexes, so the only directory
that can hold an index of the code is one that contains the code. `--no-code-index`
skips it and declares the missing symbols as a gap.

Knowledge bases and report output go somewhere outside the target. Throwaway
files go in a scratch directory, never in this repository.

## What a document is for

Every exported document exists so someone else understands the system quickly.
**Complete and accurate on detail, and as short as that allows** — both goals, and
nothing else is a goal.

- **The system as it is.** Not why it was built, not the problem it solves, not who
  feels which pain, not which parts matter most. A reader wants the shape of the
  thing that exists.
- **Do not enumerate the intent a codebase cannot hold.** A section listing product
  goal, target users, success metrics, priority and risks as absences is an apology
  that costs a reader time and says nothing about the system.
- **No unnecessary words.** A lead explaining how to read a column, a note restating
  what the table shows, a paragraph where a clause would do — cut it. Brevity is
  half the point, not a preference.
- **The reference PRD is a reference.** Take its major shape; reproducing its
  structure produces a document too long to read, which defeats the purpose it was
  written for.

Never buy brevity with accuracy, and never drop a fact to save a line: that is the
other goal, and the writer contract below is how it is kept.

## The writer contract

This is the rule an agent breaks most easily, and the one that decides whether
the tool is worth anything.

**A section may state only what its data slice holds.** `prepare` hands each
section a prompt and exactly the slice of the knowledge base that prompt may
draw on. Reading the target's source to enrich an answer is not allowed — not
because the source is off limits, but because a claim found by reading around
the data cannot be checked against the knowledge base, and every sentence in a
report has to be checkable.

If a slice is thin, say so and stop. A short honest section beats a long one
that fills gaps with plausible guesses. Two failures to watch for, both real:

- **Narrowing on plausibility.** A report once named a single recipient for a
  notification the code sends to everyone on a team. Nothing in the extracted
  facts distinguished the two, so the prose picked the smaller-sounding one.
- **Silent omission.** A report said nothing about a file that held an entire
  policy, so a reader concluded there was nothing in it. Absence has to
  announce itself — see
  [57B-267](https://linear.app/57blocks-prd/issue/57B-267).

State *no evidence observed* and *proven absent* as the different things they
are, and never merge a declared fact with an inferred claim.

## Git

- `main` is protected. Branch first, always; changes land by pull request.
- When an integration branch is in use, issue branches PR into it, and it merges
  to `main` once as the final step.
- Commit subjects are `57B-xxx: description`.
- **Identifiers are whole words.** `57B-248, 57B-250` — never `57B-248/250`,
  which links only the first.
- **A subject's identifier is a promise that the commit delivers that issue**,
  because Linear closes it on merge. Never put a deferred issue's ID in a
  subject; mention it in the body prose instead, which links without closing.
  This is how [57B-256](https://linear.app/57blocks-prd/issue/57B-256) silently
  vanished from the board once already.
- `pnpm`, never `npm`. The lockfile is pnpm's, and the engine reads lockfiles
  for a living.

## Code

- **Providers, not branches.** A missing capability is filled by another
  provider or reader, never by a special case inside an existing adapter. New
  languages, frameworks and file formats arrive as registrations.
- **No closed enums where the world is open.** Conventional values are named and
  the type stays widenable, so an unfamiliar project is unfamiliar rather than
  unsupported.
- **Every provider declares its capabilities and its gaps.** A gap is recorded
  and surfaces in the report; it is never worked around quietly. A provider that
  fails degrades only its own capabilities.
- **The engine never calls a model.** Deterministic code establishes facts;
  prompts are data; the host agent supplies the judgement. This is what lets the
  same templates run under any agent, and it is the invariant most easily broken
  by a convenient inline call.
- **No target-specific behaviour outside its adapter.** An *example* naming a
  real project is fine — a comment explaining why a threshold is what it is, or
  an illustration in a prompt — and there is plenty of it. A *rule* keyed to one
  project is not: a branch, a dictionary, or a prompt instruction that only
  makes sense against one codebase.
  `templates/overview/prompts/data-ownership.md` currently breaks this
  ([57B-296](https://linear.app/57blocks-prd/issue/57B-296)). Target *paths* live
  in `engine/targets/registry.ts` with `PA_TARGET_*` environment overrides; that
  file is test scaffolding and must not ship in a published package
  ([57B-284](https://linear.app/57blocks-prd/issue/57B-284)).
- **Evaluate what exists before writing a reader.** An off-the-shelf tool behind
  a provider boundary beats one of ours; build only where it genuinely falls
  short, and grade the two against each other in writing under `references/` —
  `references/symbol-readers.md` is the pattern.
- **Comment what is genuinely non-obvious** — why a threshold is what it is, why
  a simpler approach was rejected. Not what the next line does.
- **Leave working code alone.** No drive-by rewrites of something you happened
  to read.
- **Keep files readable**, around 500 lines as a working ceiling. One file is past
  it: `engine/kb/query.ts` at 1,142 lines, which is one class of sixty read methods
  and cannot come down by moving anything — it needs delegating into several
  readers, which is 57B-302 and a design change rather than a move. It is not
  precedent.
- **A CLI change updates its documentation in the same commit** — `README.md`
  and `.claude/skills/project-analysis/SKILL.md`. The skill is what a user's
  agent reads, so a stale command there is a broken tool, not a stale doc.
  **SKILL.md is currently stale and must not be trusted:** it names a `render`
  command that does not exist. Fixing it is
  [57B-286](https://linear.app/57blocks-prd/issue/57B-286); until that lands,
  read `scripts/export.ts` for the real interface.

## Running things

```bash
pnpm test                          # the whole suite — what a PR needs
pnpm test tests/kb/profiles        # one file, while working
pnpm run test:watch                # or watch
pnpm run typecheck
```

A target that is absent makes its tests skip and say why, so a skipped run
explains itself rather than looking green.

Rendering a report is **one command run twice**. `export --as <document>`
prepares the tasks on the first run, then assembles them once the answers are
written — there is no separate `assemble` command. `--only <section>` rebuilds
one section, `--force` starts the document over.

Migrations are append-only: a schema change is a new migration, never an edit to
an applied one.

## Linear

Work is tracked in the
[Project Analysis V2](https://linear.app/57blocks-prd/project/project-analysis-v2-39519a3d7a1d)
project. The older "Project Analysis" project is V1 and unrelated — never cite
it, and never take a decision from it.
