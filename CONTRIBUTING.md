# Contributing

## Adding a report type

A report type is one self-describing Markdown file in
`skills/project-report/references/`. Adding one is adding a file — no engine or
command-layer code enumerates the combinations, and none should start to.

1. **Declare where it applies.** Frontmatter carries `id` (equal to the file's
   basename), `scope`, `audience`, `version` and `title`. `scope` and `audience`
   are open sets; pick whatever names the report type needs. Two specs **MUST
   NOT** claim the same `scope × audience`.

2. **Write only what to write.** How to write and how to investigate are
   inherited from `skills/project-report/references/writing-rules.md`: evidence markers,
   the prohibited categories, chapter summaries, the investigation checklist, the
   risk format, glossary format, coverage requirements, diagram format, and the
   closing block. A spec **MUST NOT** restate any of them.

   Restating is not a style preference. The previous arrangement had the shared
   contract declare itself authoritative while a spec restated the same rules
   with the opposite sense; the author read the spec last, so the restatement
   won, and the contradiction was invisible to anyone reading either file alone.

3. **Add the self-checks.** The appendix lists the questions the report must be
   able to answer. It is an acceptance gate, not part of the report.

4. **Declare what it cannot be written without.** If the report type describes
   how something moves through the system rather than what the system contains,
   name the kinds it needs in `engine/report/readiness.ts`. A type with no entry
   is one that stays truthful on a thin base, and that is a claim about the type
   — make it deliberately. A capability report written from a base with no call
   graph has every chapter, cites real rows in each, and describes a system in
   which nothing calls anything.

5. **Decide whether a new deriver is needed.** If a chapter needs a fact the
   knowledge base does not hold, the exit is a deriver in the analysis layer —
   never an ad-hoc source read at report time. Only consistency checks, whose
   criterion comes from the project contradicting itself, may become derivers;
   expectation checks stay in the author's hypothesis loop.

6. **Regenerate the lock.** Instruction text is load-bearing and digested into
   `engine/contracts/lock.json`. Run `pnpm relock`, then confirm
   `pnpm verify:contracts` passes.

The English of these documents is deliberate: they are instructions to a model
that writes in whatever language the caller asks for. Authoring them in one
output language biases the report toward it.

## Changing the investigation checklist

The checklist lives in two places on purpose: `references/writing-rules.md` carries what each
item hypothesizes and where to search for it, and
`engine/contracts/report/checklist.ts` carries the ids the audit enforces. Change
both, in the same order — `pnpm verify:contracts` compares them, because an item
that drifts out of the enforced list is silently no longer required, and a dropped
item reads exactly like one that searched and found nothing.

## Changing the CodeGraph version

`VERIFIED_VERSION` in `engine/providers/codegraph/cli.ts`, `SUPPORTED_DB_SCHEMA`
in `batchdb.ts`, the version in `.github/workflows/ci.yml`, and the one named in
the README are one decision written four times. Move them together, and let
`pnpm compat:codegraph` decide whether the move holds — it indexes
`tests/fixtures/codegraph-compat` and checks that nodes, call edges and the
schema are all still what the adapter expects.

That fixture is for this and nothing else. It carries no business truth and is
not an acceptance target; a compatibility failure there means the external tool
moved, not that a report is wrong.

## Accepting a run

A report is a deliverable only with a passing `audit.json` beside it. When a run
is accepted, commit its artefacts — the report, its `manifest.json`, the agent
transcript and the audit verdict — under `truth-set/`.

The manifest is what makes the rest re-checkable: it names the snapshot, and
without it the report can only be re-audited against whatever the base happens to
hold later.

This is part of accepting it, not an optional extra. The fixtures the audit
regresses against are the committed ones; a run left only in `.analysis/` is
gitignored, and the baseline it established disappears with the next cleanup. That
has already happened once.
