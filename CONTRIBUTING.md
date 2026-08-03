# Contributing

## Adding a report type

A report type is one self-describing Markdown file in
`engine/contracts/report/specs/`. Adding one is adding a file — no engine, skill
or command-layer code enumerates the combinations, and none should start to.

Checklist:

1. **Declare where it applies.** Frontmatter carries `id` (equal to the file's
   basename), `scope`, `audience`, `inherits: contract.md`, `version` and
   `title`. `scope` and `audience` are open sets; pick whatever names the report
   type needs. Two specs **MUST NOT** claim the same `scope × audience`.

2. **Declare the fact kinds it needs.** `requires` is not documentation — it is
   the slicing input. The fact pack is cut to exactly these kinds, so a spec can
   never ask for a chapter the pack has no facts for. Every entry **MUST** appear
   in `REQUIRABLE_FACT_KINDS` (`engine/contracts/report/specs.ts`); if a kind is
   genuinely missing from that list, the knowledge base has to supply it first —
   see step 5.

3. **Write only what to write.** How to write is inherited from `contract.md`:
   evidence markers, the five prohibited categories, chapter summaries, the
   hypothesize–search–decide loop, glossary format, coverage requirements,
   diagram format and claim constraints. A spec **MUST NOT** restate or vary any
   of them — that is the drift the shared contract exists to prevent. Reference
   them by section instead.

4. **Add the self-checks.** The appendix lists the questions the report must be
   able to answer. It is a pipeline gate, not part of the report.

5. **Decide whether a new deriver is needed.** If a chapter needs a fact the
   knowledge base does not hold, the exit is a deriver in the analysis layer —
   never an ad-hoc source read at report time. Only consistency checks, whose
   criterion comes from the project contradicting itself, may become derivers;
   expectation checks stay in the model's hypothesis loop.

6. **Regenerate the lock.** Spec text is load-bearing and digested into
   `engine/contracts/lock.json`. Bump the report contract version in
   `engine/contracts/report/version.ts`, regenerate the lock, and confirm
   `pnpm verify:contracts` passes.

The English of the specs is deliberate: they are instructions to a model that
writes in whatever language the caller asks for. Authoring them in one output
language biases the report toward it.
