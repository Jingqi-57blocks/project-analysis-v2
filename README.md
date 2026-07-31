# Project Analysis V2

A knowledge base for a target project's code.

Point it at any number of source folders — git or not, any language — and it
analyzes them once into a structured, queryable knowledge base. Reports are
rendered from that knowledge base by editable templates, never by re-reading
the source.

The first two templates are a project overview and a per-module detail report.
They are the first version, not the specification: the knowledge base is
designed so a template nobody has written yet still works against it.

## Status

Under active development on the `feat/project-intelligence-v1` branch. See the
[Linear project](https://linear.app/57blocks-prd/project/项目智能-v1-图优先分析与报告流水线-0fe80a5b5868)
for the plan (milestones M0–M6). The versioned product, fact and acceptance
contracts live in `engine/contracts/`; verify them with `pnpm verify:contracts`
(see `docs/m0-contracts.md`).

## Layout

```
engine/            deterministic analysis and the knowledge base
engine/contracts/  versioned product, fact and acceptance contracts
templates/         prompt templates over the knowledge base
truth-set/         frozen acceptance truth and target manifest (test data)
scripts/           development tooling
tests/             unit, contract and real-target tests
```

## Using it

```bash
pnpm run analyze -- <path...> [--db kb.sqlite]   # read the project into a knowledge base
                     [--index-root dir]          #   put the code index elsewhere
                     [--no-code-index]           #   or skip it entirely
pnpm run status  -- <path>    [--db kb.sqlite]   # what a knowledge base holds
pnpm run export  -- --as json                    # the knowledge base as one JSON document
pnpm run export  -- --as overview [--format html]
pnpm run export  -- --as overview --only <section>   # rebuild one section
pnpm run export  -- --as capability --param capability=<id>
```

`analyze` is the only command that touches the project, and it reads
everything except one thing: the code indexer writes a cache into the
directory it is pointed at, and offers no way to relocate it. Every run prints
that path before writing, and records it in the knowledge base so the reports
say so too. `--index-root` moves it, at the cost of indexing only what is
under the directory you name; `--no-code-index` skips it and declares the
missing symbols as a gap.

Everything after that reads the knowledge base. `export` produces the same
bytes for the same run and needs no access to the source at all.

### Reports

A report is a template, not a feature of the tool. `prepare` renders the
sections code can answer and writes one task per section that needs judgement
— a prompt, and exactly the slice of the knowledge base that prompt may use.
An agent answers those tasks; `assemble` splices them in and refuses to
publish a section that was never written.

The engine never calls a model, which is what lets the same templates run
under Claude Code, Codex CLI or anything else with an agent in it. See
[templates/HOST.md](templates/HOST.md) for the contract. To write your own,
copy a directory under `templates/` and pass its path where a template id
goes: `export --as ./my-template`.

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
