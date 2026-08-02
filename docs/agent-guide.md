# Agent guide — developing, running and accepting Project Intelligence V1

For an AI agent (or engineer) continuing this project from the repository and Linear alone. It records
the architecture, the extension seams, the report model, and the rules that must not be broken. Pair it
with `docs/integration-workflow.md` (branch/PR flow) and `docs/m0-contracts.md` (the frozen contracts).

## 1. What the system is

Point it at any number of source roots — git or not, any language — and it analyses them **once** into a
structured, queryable knowledge base (KB). Reports are rendered from the KB by presets, never by
re-reading source. One analysis serves many report combinations.

```
source roots ─▶ analysis ─▶ knowledge base ─▶ report pipeline ─▶ {project,module} × {product,developer}
               (once)       (facts+coverage)   (presets+slices)     Markdown + HTML
```

## 2. The pipeline, module by module

- **Analysis** — `engine/run/analyze.ts` (`runAnalyze({paths, indexRoot, dbPath})`). Runs the providers
  over each root, derives facts, persists to a SQLite snapshot. Returns `{runId, snapshotId, identity,
  testCoverage}`. `identity` is a **content** digest (not the random run id) — reproducible from source.
- **Providers** (`engine/providers/*`) — CodeGraph (the batch code index), symbols, manifests, logic,
  conventions, outbound, uicalls, datamodel, and **framework routes**
  (`engine/providers/frameworkroutes/`: gin, express, react-router, vue-router readers).
- **Derivation** (`engine/kb/derive.ts`) — turns provider records into KB facts: routes → features →
  modules (`engine/modules/form.ts`), plus behaviour facts from the `engine/kb/*-observe.ts` observers and
  `notification-reachability.ts`. Emits **coverage notes** (`engine/kb/coverage.ts`) — a gap is stored as a
  fact about the analysis, because silence about a gap reads as a finding about the project.
- **Knowledge base** (`engine/kb/query.ts`, `openKnowledgeBase(store, runId)`) — the query surface:
  `modules()`, `features()`, `endpoints()`, `screens()`, `entities()`, `coverageNotes()`, behaviour facts
  via `engine/kb/behavior-query.ts`.
- **Report pipeline** (`engine/report/*`):
  - `slice-resolve.ts` — resolves a section's fact kinds within a scope to `CitedFact`s
    (`{factId, kind, value, citation, resolutionClass}`); module scope filters by file membership, project
    scope reads the whole snapshot.
  - `plan.ts` (`compileExecutablePlan`) — from a `ReportRequest` + snapshot identity + coverage function,
    produces the `ReportPlan` (deterministic), applicability decisions, and materialized slices (one per
    `sliceKey`, deduplicated).
  - `deterministic-content.ts` / `deterministic-host.ts` — render the fact-grounded, model-free layer.
  - `execute.ts` (`executeAuthoredTasks`) — runs authored tasks through the Host Agent, retrying a failed
    task alone within budget; fail-closed when a required block never validates.
  - `dual-report.ts` (`produceDualReport`) — assembles + renders **Markdown and HTML from one structure**
    (`render.ts`; one `structureDigest` binds both).
  - `grounding.ts` — validates authored prose against the slice (foreign-citation / value-mismatch /
    no-citation).

## 3. How work flows

Milestones M0–M6 (Linear project 项目智能 V1). Each **leaf** issue → a branch off
`feat/project-intelligence-v1` named `pi-<n>`, a Linear-linked PR into `feat`, squash-merged after CI
(`build-and-test` + `pr-contract`; the PR body needs a linear.app link, `Fixes PI-<n>`, `## Tests`,
`## Acceptance`). Parent/rollup issues hold no code. The final `feat → main` PR is **PI-33 only**, and it
needs explicit human approval. Progress lives in Linear + PR evidence, never a duplicated status file in
the repo.

## 4. Extension recipes

- **A new fact kind** — add it to the catalog (`engine/contracts/report/catalog.ts` `inputFactKinds`) and
  the reader taxonomy in `slice-resolve.ts` (`ReaderClass`), persist it in `engine/kb`, and give it a
  citation via `engine/structural/provenance.ts`.
- **A behaviour deriver** — a generic AST/reachability observer under `engine/kb/*-observe.ts`, wired into
  `derive.ts`. Key on **library-standard** shapes, never a target's own names; emit a coverage limit for
  what it cannot read. See `state-transition-observe.ts`, `boundary-observe.ts`,
  `outbound-integration-observe.ts`, `notification-reachability.ts` as templates.
- **A report section** — add a `SectionDefinition` to `catalog.ts` (scope, audience, requirement,
  `inputFactKinds`) and reference it from a preset (`engine/report/presets/{pm,dev}.ts`).
- **A document preset** — a question set + section list per audience under `engine/report/presets/`.
- **A framework enricher** — only after the PI-27-style scorecard adopts it. Add a reader under the
  existing provider contract (e.g. a `FrameworkRouteReader` in `frameworkroutes/readers/`), **detect-gated**
  on a dependency, declaring limits + failures, merging by canonical identity (additive, never overriding
  generic facts). Measure before/after and prove no regression on the other targets. Express app-object
  (`readers/express.ts`) and Vue Router (`readers/vuerouter.ts`) are the worked examples.

## 5. The report model

- **Section → ContentBlock** — a section is a question; its blocks are the answers. A **deterministic**
  block renders straight from cited facts (no model). An **authored** block is prose a Host Agent writes
  from the block's fact digest.
- **ExecutionBundle / GenerationPolicy** — authored blocks are grouped for execution; the policy bounds
  attempts/retries. `standard-v1` grouping shares slice input across a bundle; "one block per bundle" is a
  diagnostic baseline, **not** a user-facing tier.
- **The Host Agent seam calls no model.** `engine/report/deterministic-host.ts` is the model-free host; the
  ambient agent (Claude Code / Codex CLI / future) is the authoring host. The engine emits a portable
  bundle of bounded, budgeted per-block tasks — it never wires a vendor SDK. This is what keeps it
  model-portable.
- **Why no ai-optional in V1** — every required section is either deterministically grounded or an
  authored block with a deterministic fallback; there is no "maybe the model fills this in" tier. A
  complete cited-fact report always exists; prose is an enhancement within budget.
- **Preview & receipts** — the plan is inspectable before execution (`compileExecutablePlan` →
  applicability + slices); execution emits per-task ledgers + an `executionDigest`.

## 6. Determinism & identity

Two separate identities (`engine/contracts/report/snapshot.ts`, `plan.ts`):
- **AnalysisSnapshot identity** — source snapshot + config + provider/schema versions. Changing the source,
  a provider, the schema or config produces a **new** snapshot.
- **ReportPlan identity** (`planDigest`) — requested targets + scopes + preset versions + normalized slice
  queries + executor kind + model id + language + generation params. Changing the **report combination** or
  the model changes the plan identity but **not** the snapshot: a different report is not a new analysis.

Same snapshot + same request ⇒ byte-identical plan, slice digests, deterministic blocks, execution and
structure digests. Concurrency-completion order never enters content identity. Digests key off the content
identity, so two machines analysing the same frozen source reach identical results.

## 7. Acceptance & gates

- **Golden slice** — the WCP-V2 leave module, graded by `engine/gates/{structural-truth,behavior-truth,
  report-truth}.ts` against the human-verified `truth-set/` ledger (`engine/contracts/truth/leave.ts`).
  Release-blocking thresholds: structural must-find, behaviour must-find, report must-print all 100%.
  Reproduce: `tsx scripts/run-fresh-baseline.ts`.
- **Cross-project sentinels** — the frozen `truth-set/angels-pizza/sentinels.json`, graded by
  `engine/gates/sentinel-smoke.ts` (`gradeSentinels`). Re-graded from source in the release audit.
- **Release audits** (M6, reproduction scripts write to `.analysis/`): `pi29-release-candidate.ts` (the RC),
  `pi49-50-release-audit.ts` (fact accounting + citation/source-truth), `pi31-perf-repro-recovery-audit.ts`
  (perf + reproducibility + recovery). All consume the RC.

## 8. Rules that must not be broken

- **No target literal in production code.** A target project's name, path or framework special-case never
  enters the pipeline — targets appear only in acceptance fixtures and the human-owned `truth-set/`.
- **A gap is disclosed, never silent.** `not-found`, `not-applicable`, `unknown`, `unsupported`, `failed`,
  `truncated` are distinct outcomes. An empty result must never mask a not-run: a scope with no code to
  scan reads `unknown`, not "found none" (`slice-resolve.ts scopeIsResolved`).
- **No out-of-slice claim.** A block cites only facts in its own slice.
- **No fabricated reproducibility.** Probabilistic prose is deferred, not faked byte-stable; a semantic
  difference is classified, not hidden.
- **Fresh runs only.** Never reuse or hand-edit a completed run or the "latest published" snapshot to pass
  acceptance; never adjust the truth set to fit current output (correct it only against source, with a
  recorded audit).
- **Enrich generically.** A reader/enricher only locally augments; it never becomes the sole producer of
  module identity, report scope, or generic facts.
