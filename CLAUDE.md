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
- **Keep files readable**, around 500 lines as a working ceiling. Four files are
  past it — `engine/kb/query.ts`, `engine/providers/logic/provider.ts`,
  `engine/render/fragments.ts`, `tests/render/roundtrip.test.ts`. Split them when
  next touched; none of them is precedent.
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
