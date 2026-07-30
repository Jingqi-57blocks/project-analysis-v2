# Project Analysis V2

A knowledge base for a target project's code.

Point it at any number of source folders — git or not, any language — and it
analyzes them once into a structured, queryable knowledge base. Reports are
rendered from that knowledge base by editable templates, never by re-reading
the source.

Four templates ship: a project overview, a per-capability detail report, a
coverage report, and a recovered specification — the system's behaviour written
in the shape a rebuild reads, structurally complete and intent-empty. They are
the first version, not the specification: the knowledge base is designed so a
template nobody has written yet still works against it.

## Status

Early. See the [Linear project](https://linear.app/57blocks-prd/project/project-analysis-v2-39519a3d7a1d)
for the current plan — M0 is the MVP demo.

## Layout

```
engine/     deterministic analysis
templates/  prompt templates over the knowledge base
references/ design decisions and grading notes
scripts/    development tooling
tests/      unit and target-driven tests
```

## Using it

```bash
pnpm run analyze -- <path...> [--db kb.sqlite]   # read the project into a knowledge base
                     [--no-code-index]           #   without building a code index
pnpm run status  -- [--workspace dir] [--db kb.sqlite] [--run id]
pnpm run export  -- --as json                    # the knowledge base as one JSON document
pnpm run export  -- --as overview [--format html] [--lang <language>]
pnpm run export  -- --as coverage
pnpm run export  -- --as prd                      # the recovered specification
pnpm run export  -- --as capability --param capability=<id>
pnpm run export  -- --as overview --only <section>   # rebuild one section
                     [--force]                       #   or start the whole document over
```

`status` takes no positional path — it reads `--workspace`, defaulting to the
current directory.

`analyze` is the only command that reads the project, and it never changes it.
The code indexer does create a `.codegraph/` directory — its own data, in the
folder that holds the analyzed roots, so for a workspace of five repositories it
lands in the folder containing them and never inside any of them. Every run
reports that path when it finishes and records it in the knowledge base, so the
reports say so too.

Where it goes is not configurable: the indexer stores its database inside
whatever directory it indexes, so the only directory that can hold an index of
your code is one that contains your code. `--no-code-index` skips it and declares
the missing symbols as a gap.

Everything after that reads the knowledge base. `export` produces the same
bytes for the same run and needs no access to the source at all.

### Reports

A report is a template, not a feature of the tool. Rendering has two phases and
**one command run twice.** The first run prepares: it renders the sections code
can answer and writes one task per section that needs judgement — a prompt, and
exactly the slice of the knowledge base that prompt may use. An agent answers
those tasks. Running the same `export` command again assembles, splicing the
answers in and refusing to publish a section that was never written.

The engine never calls a model, which is what lets the same templates run
under Claude Code, Codex CLI or anything else with an agent in it. See
[templates/HOST.md](templates/HOST.md) for the contract. To write your own,
copy a directory under `templates/` and pass its path where a template id
goes: `export --as ./my-template`.

## Development

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run flow        # where each issue branch stands, and what it still owes
```

`flow` reads local branches named for an issue and fails when one shares unlanded
commits with another issue's branch, or carries a commit for a different issue.
Run it before cutting a branch and before calling an issue done. `PA_FLOW_BASE`
names the branch to compare against, for when the integration branch changes.

Conventions that are not obvious from the code — the read-only rule, the writer
contract, git and commit format — are in [CLAUDE.md](CLAUDE.md).

### Targets

The engine is developed and graded against **real projects**, not a hand-authored
fixture. A fixture is not per-target — analyzing a new project never requires one
— but a synthetic workspace would be code written to be *convenient to analyze*,
which flatters the tool and predicts nothing about real behavior.

Known targets are declared in `engine/targets/registry.ts`. They live outside
this repository and are **never vendored into it**. Paths are per-machine and
overridable:

```bash
PA_TARGET_WCP_V2=/somewhere/else pnpm test
```

A target that is absent is a normal state: tests skip and print why, so a
skipped run explains itself rather than looking green.

**A target's own files are never changed.** `resolveTarget` and
`digestDirectory` only stat and read; `deriveVariant` refuses any output path
that overlaps a source root, sits inside a registered target, or points at a
non-empty directory it did not create; and the knowledge base cannot be written
inside a root. Those guards are enforced and tested, not assumed.

The code index is the one thing this tool adds beside a project, and it adds
nothing to one: `.codegraph/` goes in the directory above the analyzed roots,
never in a root.

Cases the real targets don't supply are produced by derivation:

```bash
pnpm run target:derive -- --target wcp-v2 --root wcp-auth --without-manifest
```

Derived copies land in the gitignored `.targets/` directory. `missing-root` and
`single-root` need no derivation at all — they are workspace selection against a
real target, which the engine has to support regardless.
