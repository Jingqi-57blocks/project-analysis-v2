---
name: project-analysis
description: Analyze source roots once into a cited knowledge base, then generate project or module reports without re-reading source.
---

# Project Analysis

Use the two stages separately. Never ask a report-generation agent to inspect
the target source.

## 1. Analyze once

```bash
pnpm run analyze -- <target-root...> --db <kb.sqlite> [--index-root <dir> | --no-code-index]
```

`analyze` inventories the selected roots, runs generic providers and CodeGraph
when available, derives structural and behavioural facts, and publishes one
SQLite snapshot. The target is read-only. The database, report work directory
and report output must all be outside every analyzed root.

## 2. Generate reports from the snapshot

Chinese non-technical project + module reports:

```bash
pnpm run report -- \
  --db <kb.sqlite> \
  --project \
  --module worklog \
  --module leave \
  --out <report-directory>
```

Any non-empty combination is legal:

```bash
pnpm run report -- --db <kb.sqlite> --project
pnpm run report -- --db <kb.sqlite> --module leave
pnpm run report -- --db <kb.sqlite> --project --module leave --module reimbursement
```

`--project` creates the overview. Each repeated `--module` creates one detail
page. A module name must resolve to a classified canonical module; unresolved
names fail closed and never widen to the whole project. The site entry is
`index.html`; CSS and JavaScript are local static assets.

## What the model may do

- Classify the bounded formed-module list as product, aggregate, technical,
  infrastructure, external or unresolved. The JSON result is reused only while
  candidate and classifier identities match.
- Summarize cited facts and group flow facts into readable business flows.
- Use only fact ids assigned to that document and section.

The model does not read source, discover facts, choose report scope, render
deterministic tables, or edit HTML after export. Module flow authoring must place
every supplied `feature-flow` fact and every selected `guard` / `decision` fact
in the structured flow result. Invalid output retries once and then blocks the
run.

## Required checks

Before accepting a report:

1. `pnpm typecheck` and `pnpm test` pass.
2. The run audit says the report is complete and its consistency audit is clean.
3. `manifest.json` lists the requested project/module pages and one shared
   snapshot identity.
4. `metrics.json` records analysis, classification, authoring and export cost.
5. Every requested module has a non-empty source membership and major-flow
   diagrams with visible branch conditions.
6. Inspect the generated site at desktop and mobile widths; do not hand-edit it.

## Invariants

- One source analysis serves every report combination.
- CodeGraph is the structural baseline; generic source/AST providers supplement
  semantics the graph cannot express; framework readers are local enrichers.
- A shared router file does not widen a module: module identity, exact entry key,
  feature identity and file evidence all constrain its slice.
- `not-found`, `not-applicable`, `unknown`, `unsupported`, `failed` and
  `truncated` are distinct.
- No target name, vendor list or target path belongs in production extraction or
  classification logic.
- No report is complete when a required authored block, citation, flow fact or
  consistency audit is missing.
