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

Early. See the [Linear project](https://linear.app/57blocks-prd/project/project-analysis-v2-39519a3d7a1d)
for the current plan — M0 is the MVP demo.

## Layout

```
engine/     deterministic analysis — filled in from MVP 2 onward
templates/  prompt templates over the knowledge base
fixtures/   demo workspaces used to develop and grade every stage
scripts/    development tooling
```

## Using it

```bash
pnpm run analyze -- <path...> [--db kb.sqlite]   # read the project into a knowledge base
pnpm run status  -- <path>    [--db kb.sqlite]   # what a knowledge base holds
pnpm run export  -- [--db kb.sqlite] [--run id]  # the knowledge base as one JSON document
```

`analyze` is the only command that touches the project, and it only reads:
analyzed source is never written to, and the code index one of the readers
builds is written beside the roots rather than inside any of them.

Everything after that reads the knowledge base. `export` produces the same
bytes for the same run and needs no access to the source at all.

## Development

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run fixture:setup            # materialise a runnable copy of the demo fixture
pnpm run fixture:setup -- --force # rebuild it, discarding local edits
```

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
