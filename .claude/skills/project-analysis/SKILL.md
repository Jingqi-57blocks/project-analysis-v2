---
name: project-analysis
description: Analyze any codebase into a knowledge base of checkable facts, then render reports from it — a project overview, or a per-module detail document. Use when asked to analyze, diagnose, audit, map, or explain a project, or to produce a report about one. Works on any number of source folders, any language, with no per-project configuration.
---

# Project Analysis

Two stages, and you must not blur them.

1. **Code establishes the facts.** `analyze` reads the project into a SQLite knowledge base: routes, symbols, tables, business rules, flows, findings — each with a location, none of them written by you.
2. **You write the prose.** `render prepare` fills the sections code can fill and hands you the rest as tasks, each with a prompt and the slice of the knowledge base that prompt may use. You write the answers; `render assemble` splices them in.

Your judgement is wanted in stage 2 and nowhere else. A sentence in a report must be true of the data slice it was written from.

## Running it

From the project-analysis checkout:

```bash
pnpm run analyze -- <target-path...> --db <kb.sqlite>
pnpm run render  -- prepare overview --db <kb.sqlite> --out <runDir>
# answer every task (below), then:
pnpm run render  -- assemble <runDir> --html
```

For one module — get ids from `pnpm run export -- --db <kb.sqlite>`:

```bash
pnpm run render -- prepare module --db <kb.sqlite> --param module=<id> --out <runDir>
```

Add `--lang <language>` to `prepare` for a report in another language. Identifiers, paths and table names stay as the code spells them.

**The analyzed project is read-only.** `analyze` never writes inside it, and neither may you: no formatting, no fixes, no `git` commands in the target. Point `--db` and `--out` somewhere outside it.

## Answering the tasks

`prepare` prints what it is waiting for. For each `tasks/<id>/` with no `answer.md`:

1. Read `prompt.md` — what this section is.
2. Read `data.json` — **everything you are allowed to state.**
3. Write the section body to `answer.md`. Markdown, no heading of its own unless the prompt asks for headings, no preamble, no sign-off.

Do not edit `report.partial.md`, the prompts, or the data. Do not read the target's source to enrich an answer: the analysis is what is being reported, and a claim you found by reading around it cannot be checked against the knowledge base.

If `data.json` is thin, say so and stop. A short honest section beats a long one that fills gaps with plausible guesses.

## What assemble refuses

An empty answer; one over its word limit; a heading shallower than the contract allows; text containing `<!-- llm:`; the wrong number of top-level headings where one per item was asked for; a missing answer. `--allow-missing` publishes with the gap stated rather than closed.

Fix the answer and run `assemble` again — `prepare` does not need repeating.

## Reading the result

`report.md` is the document; `report.html` if you asked for it. `assembled.json` records what happened per section.

Every report ends with what the analysis could not establish. That section is not padding — a reader deciding on this needs to know what was not measured, and it is the first thing to check before trusting the rest.
