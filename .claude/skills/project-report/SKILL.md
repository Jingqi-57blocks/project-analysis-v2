---
name: project-report
description: Write a source-understanding report from an analysis knowledge base. Use when asked to generate a project overview or a feature detail report from an analysis snapshot. Never reads the analysed project's source.
---

# Project report

You turn one knowledge base into one report. Auditing and rendering happen outside
you: you do not decide whether the report ships, and you do not produce HTML.

## ACTION REQUIRED

Reading this file is not the task. **Begin at step 1 now.** Do not reply with a plan;
produce the report.

You are given, in the invocation:

| Input | Meaning |
| -- | -- |
| `kbPath` | The knowledge base — the whole of what is knowable here |
| `specId` | Which output spec governs this report |
| `language` | The target language of the report |
| `subject` | The capability this report is about (feature reports only) |
| `reportPath` | Where to write the finished report |
| `scratchPath` | Where every intermediate file goes |
| `repoRoot` | Root the contract paths below resolve against |

If one is missing, stop and say which. Do not guess a default. Everything you write
that is not the report goes under `scratchPath` — a run that scatters intermediates
leaves them behind forever, because nobody knows which files were yours.

## 1 — Read three files, then the base

The contracts live in the **repository**, not in this skill's directory. Resolve every
path against `repoRoot`; a read that lands under `.claude/skills/` has gone to the
wrong place and comes back empty.

1. `<repoRoot>/engine/contracts/kb/reading-the-kb.md` — how to read the base.
2. `<repoRoot>/engine/contracts/report/writing-rules.md` — how to write and how to
   investigate, including the checklist and the closing block.
3. `<repoRoot>/engine/contracts/report/specs/<specId>.md` — the chapters this report
   has, and what belongs in each.

**MUST NOT** read the other specs. **MUST NOT** read the analysed project's source,
under any circumstance — this is the one rule whose violation invalidates the whole
run, because a report that sometimes reads source is no longer reproducible, no
longer auditable, and no longer cheaper than reading the code.

Then query the base at `kbPath`, read-only, with SQL.

## 2 — Census, then investigate

Both passes are defined in `reading-the-kb.md`. Do them in order and do not skip the
second: the census gives you the shape, the investigation gives you the findings. A
report built from the census alone is a table of contents with numbers in it.

Work the checklist item by item. Each ends in one of three verdicts — hit,
searched-and-not-found, or cannot-be-determined-here — and **every item MUST appear
in the report with its verdict**, including the ones that found nothing.

## 3 — Write the report

Write it to `reportPath`, in `language`, covering every chapter the spec numbers, in
its order. `writing-rules.md` governs how; the spec governs what. Neither is restated
here — read them.

End the report with the machine-readable block `writing-rules.md` specifies: each checklist
item's id, its verdict, and the fact ids or record keys behind it. The audit reads
that block and checks every id against the base, so an id you did not actually read
will be caught.

## Before you finish

- [ ] Every chapter the spec numbers is present, in the spec's order.
- [ ] Every checklist item appears with one of the three verdicts.
- [ ] Every `unavailable` item is stated, not silently dropped.
- [ ] Every coverage figure carries its denominator.
- [ ] No table name, enum value or code spelling left untranslated in the body.
- [ ] The closing block lists an id for every non-empty verdict.
- [ ] You did not read the analysed project's source.

Then report the path you wrote and stop. The engine audits the result; a failing
audit means the report is not a deliverable, and that verdict is not yours to make.
