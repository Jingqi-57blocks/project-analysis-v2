# Project Analysis V2

A knowledge base for a target project's code.

Point it at any number of source folders — git or not, any language — and it
analyzes them once into a structured, queryable knowledge base. Reports are then
written from that knowledge base, never by re-reading the source.

Two report types exist today: a project overview and a per-capability detail
report, both for a non-technical reader. They are the first version, not the
specification — adding a report type is adding one Markdown file.

## Requirements

Node 22 or later, pnpm 10, and **CodeGraph 1.5.0** for the call graph. The
version is pinned rather than detected: the adapter reads CodeGraph's own index
database, because 1.5 has no batch edge export and the alternative is one
subprocess per symbol. A different version, or an index schema other than the
one this build reads, refuses the run — the fallback supplies symbols without
call relationships, and a report written from that has every chapter and nothing
connecting them. `--allow-degraded` accepts that trade explicitly.

## Status

Under active development. The versioned product, fact and acceptance contracts
live in `engine/contracts/`; verify them with `pnpm verify:contracts` (see
`docs/m0-contracts.md`).

## Layout

```
engine/            deterministic analysis and the knowledge base
engine/contracts/  versioned contracts
skills/            the report skill: SKILL.md plus the references it reads
truth-set/         frozen acceptance truth, target manifest and accepted reports
scripts/           development tooling
tests/             unit, contract and real-target tests
```

## Using it

```bash
pnpm run analyze -- <path...> [--db kb.sqlite]   # read the project into a knowledge base
                     [--index-root dir]          #   put the code index elsewhere
                     [--no-code-index]           #   or skip it entirely
pnpm run status  -- <path>    [--db kb.sqlite]   # what a knowledge base holds
pnpm kb:query --sql "select ..." [--run <runId>]  # read one snapshot, scoped to it
pnpm kb:readiness --spec <specId> [--run <runId>] # can this base answer this report type

pnpm audit:report <report.md> [--db kb.sqlite]    # check a written report against the base
```

A knowledge base is append-only: one file can hold several workspaces, several
runs, and snapshots left inert by runs that failed before publishing. So both
readers work on one named snapshot rather than on the file. `kb:query` binds
`:snapshot` and refuses a query that reads a snapshot-scoped table without it;
`audit:report` reads the `manifest.json` beside the report and refuses if the
snapshot it names is not the one the base resolves. Neither can create or migrate
a database — a reader that creates answers a mistyped `--db` with an empty base
instead of an error.

`analyze` is the only command that touches the project, and it reads
everything except one thing: the code indexer writes a cache into the
directory it is pointed at, and offers no way to relocate it. Every run prints
that path before writing, and records it in the knowledge base so the reports
say so too. `--index-root` moves it, at the cost of indexing only what is
under the directory you name; `--no-code-index` skips it and declares the
missing symbols as a gap.

Everything after that reads the knowledge base and needs no access to the source.

### Reports

A report is written by the `project-report` skill, which reads the knowledge base
directly and writes one document. The skill is one folder — `skills/project-report/`,
with `SKILL.md` and the three references it reads: how to read the base, how to write
and how to investigate, and which chapters this report type has. Adding a report type
is adding a reference file.

The folder is the unit: hand it to another tool and it works. `.claude/skills/` holds
a symlink to it rather than a copy, so there is one source of truth and nothing to
keep in step.

There is no pipeline around the skill, deliberately. The one thing an author
cannot do is check itself, so that is the one thing the engine does.
`pnpm audit:report` resolves every identity the report cites — in the body as
well as in `checklist.json` and `claims.json` — against the snapshot the report
names, checks every cited path against the files that were actually analysed, and
checks every proportion against a quantity the base can justify. **A report
without a passing `audit.json` beside it is not a deliverable.**

Be precise about what that does and does not settle. It settles whether the rows
a statement rests on exist and were read; it does not settle whether the statement
follows from them. Nothing mechanical can. What it removes is the case where the
prose rests on nothing at all — which is not hypothetical: in a three-model trial
over one knowledge base the three outputs were indistinguishable by appearance,
and the fabricated one was just as well formatted, just as complete, and the
second longest.

## Development

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm run typecheck
pnpm run verify:contracts   # validate the M0 contracts and the drift gate
pnpm test
```

### Targets

The engine is developed and graded against **real projects**, not a hand-authored
fixture. A fixture is not per-target — analyzing a new project never requires one
— but a synthetic workspace would be code written to be *convenient to analyze*,
which flatters the tool and predicts nothing about real behavior.

Known targets are declared in `tests/support/targets/registry.ts` — isolated
from the production engine, which never decides analysis behavior from a target
literal. They live outside this repository and are **never vendored into it**.
Paths are per-machine and overridable:

```bash
PA_TARGET_WCP_V2=/somewhere/else pnpm test
```

A target that is absent is a normal state: tests skip and print why, so a
skipped run explains itself rather than looking green.

**Targets are read-only.** Nothing in this tool writes to them. `resolveTarget`
and `digestDirectory` only stat and read, and `deriveVariant` refuses any output
path that overlaps a source root, sits inside a registered target, or points at
a non-empty directory it did not create. Those guards are enforced and tested,
not assumed.

Cases the real targets don't supply are produced by derivation:

```bash
pnpm run target:derive -- --target wcp-v2 --root wcp-auth --without-manifest
```

Derived copies land in the gitignored `.targets/` directory. `missing-root` and
`single-root` need no derivation at all — they are workspace selection against a
real target, which the engine has to support regardless.
