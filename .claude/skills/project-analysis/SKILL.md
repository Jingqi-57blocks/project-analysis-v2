---
name: project-analysis
description: Analyze source roots once into a cited knowledge base. Use when asked to analyze a project, or to refresh a knowledge base before reports are written from it.
---

# Project Analysis

Reading a project and writing about it are separate stages, and this skill is the
first one. A report is written from the knowledge base by the `project-report`
skill, which never reads the analysed source — that separation is what makes one
analysis serve many reports, and what makes every report auditable.

## Analyze once

```bash
pnpm run analyze -- <target-root...> --db <kb.sqlite> [--index-root <dir> | --no-code-index]
```

`analyze` inventories the selected roots, runs generic providers and CodeGraph
when available, derives structural and behavioural facts, and publishes one
SQLite snapshot. The target is read-only, and the database must sit outside every
analyzed root.

## Then write reports from it

Use the `project-report` skill. It reads the knowledge base and nothing else.

## Invariants

- One source analysis serves every report.
- CodeGraph is the structural baseline; generic source/AST providers supplement
  semantics the graph cannot express; framework readers are local enrichers.
- `not-found`, `not-applicable`, `unknown`, `unsupported`, `failed` and
  `truncated` are distinct.
- No target name, vendor list or target path belongs in production extraction or
  classification logic.
