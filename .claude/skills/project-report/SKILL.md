---
name: project-report
description: Write a source-understanding report from a bounded fact pack. Use when asked to generate a project overview or module detail report from an analysis snapshot. Never reads the analysed project's source.
---

# Project report

You turn a **bounded fact pack** into one report: read the pack, write the
document the spec describes.

Slicing, auditing and rendering happen outside you. You do not choose what to
read, you do not decide whether the report ships, and you do not produce HTML.

## ACTION REQUIRED

Reading this file is not the task. **Begin at step 1 now.** Do not reply with a
summary of what you are about to do; produce the artefacts.

You are given, in the invocation:

| Input | Meaning |
| -- | -- |
| `packDb` | The fact pack, as a SQLite database — the whole of what is knowable here |
| `packIndex` | Its index: what is in scope and how much of it |
| `specId` | Which output spec governs this report |
| `language` | The target language of the report |
| `reportPath` | Where to write the finished report |
| `scratchPath` | Where every intermediate file goes |

If any is missing, stop and say which. Do not guess a default.

**Every file you write that is not an output goes under `scratchPath`.** Helper
scripts, partial results, notes — all of it, and nothing outside it. A run that
scatters intermediates leaves them behind forever, because nobody knows which
files were yours. The engine deletes `scratchPath` once the run has produced its
report, and keeps it when the run fails, so a failed run stays diagnosable.

## NOW — load exactly four things

The contracts live in the **repository**, not in this skill's directory. `repoRoot`
is given in the invocation; every path below is relative to it, so resolve them
against `repoRoot` rather than against wherever this file sits. A read that
resolves under `.claude/skills/` has gone to the wrong place and will come back
empty.

**MUST** read, in this order:

1. `<repoRoot>/engine/contracts/kb/kb-contract.md` — how to read the pack.
2. `<repoRoot>/engine/contracts/report/specs/contract.md` — the shared writing contract.
3. `<repoRoot>/engine/contracts/report/specs/<specId>.md` — the one spec that governs this report.
4. The pack at `packDb` — query it with SQL, do not scan files.

**MUST NOT** read the other specs. Four specs run to a thousand lines together;
loading all of them crowds out the facts, and writing a non-technical overview
never needs the technical module spec.

**MUST NOT** read the analysed project's source, under any circumstance. The pack
is the whole of what is knowable. A gap in it is reported as a gap — it is not a
reason to go looking. This is the single rule whose violation invalidates the
entire run, because a report that sometimes reads source is no longer
reproducible, no longer auditable, and no longer cheaper than reading the code.

## NEXT — walk every kind before writing anything

**MUST** open every kind listed in the pack's `requires`, in the order
`kb-contract.md` gives: `run-context`, `coverage-note`, `health-signal`,
`structural-finding`, then the computed shape, then raw facts.

This is not advice. In the trial that produced a fabricated report, the run
issued 13 queries, never touched `structural-finding`, `health-signal` or
`coverage-note`, and then filled in the architecture-risk and coverage chapters
those kinds feed. It read well. It was invented. Walking the kinds first is what
stops that.

For each kind, note: how many rows, and what they say. A kind with zero rows in
scope is a fact about the project and **MUST** be reported as such.

## ACT — write the report

Write it to `reportPath`, in `language`, following the spec's chapter list and the
shared contract's rules. Cover every chapter the spec numbers, in its order.

Every statement rests on facts you read from the pack, and cites them. The rules
you will most easily break, restated:

* Evidence markers are `fact`, `verified`, `inferred`, `unavailable`. Render each
  in the target language.
* **Say what the system does.** "Twenty-five endpoints write to four tables" is
  true and useless alone; the reader needs "this module handles leave requests
  from submission through multi-level approval". Mark that `inferred` and name the
  facts it reads. A report that refuses to say what a system does has not done its
  job.
* The line is between **what this is** and **what to do about it**. **MUST NOT**
  write design intent, motive, consequences, solutions, or evaluation without
  evidence. A precise fact carries its own weight; appending what it might cause
  crosses the line.
* Translating a term is not inference — a report that prints raw table and
  function names is not acceptable.
* Every chapter closes with a summary that **generalizes** the chapter's own
  facts and introduces nothing new.
* Every coverage number carries its denominator.
* Diagrams are Mermaid, in a fenced ` ```mermaid ` block — never hand-written SVG.
  Branch labels use the target language, never the code's enums.

## Before you finish

Check each, and fix what fails:

- [ ] Every kind in `requires` was opened, and every zero-row kind is reported.
- [ ] Every chapter the spec numbers is present, in the spec's order.
- [ ] Every `unavailable` item is stated, not silently dropped.
- [ ] No design intent, motive, consequence, solution, or unevidenced evaluation.
- [ ] Every chapter has a generalizing summary.
- [ ] Every coverage figure has its denominator.
- [ ] No untranslated table names, enum values or code spellings in the body.
- [ ] The glossary has all three columns, and every abbreviation its expansion.
- [ ] You did not read the analysed project's source.

Then report the two paths you wrote and stop. The engine audits the result; a
failing audit means the report is not a deliverable, and that verdict is not
yours to make.
