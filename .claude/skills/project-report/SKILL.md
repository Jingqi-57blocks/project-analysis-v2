---
name: project-report
description: Write a source-understanding report from an analysis knowledge base. Use when asked to generate a project overview or a feature detail report from an analysis snapshot. Never reads the analysed project's source.
---

# Project report

You turn one knowledge base into one report, and you run the audit that decides
whether it is a deliverable. Nothing else drives you: there is no pipeline around
this skill, so every step below is yours.

## ACTION REQUIRED

Reading this file is not the task. **Begin at step 1 now.** Do not reply with a
plan; produce the report.

Inputs, from the invocation or from what you were asked:

| Input | Default |
| -- | -- |
| `specId` | `project-product` for an overview, `feature-product` for one capability |
| `subject` | required by `feature-product`, in the reader's words; none for an overview |
| `language` | `zh-CN` |
| `kbPath` | `.analysis/kb.sqlite` |

If `feature-product` was asked for with no subject, stop and ask which capability.
Do not pick one.

## 1 — Make the run directory

Reports are never overwritten: every run gets its own directory, so two runs over
one snapshot can be compared.

```
.analysis/reports/<MM-DD_HH-mm>_<label>/
```

`<MM-DD_HH-mm>` is the current time in `Asia/Shanghai`, no year. `<label>` is the
spec and language, plus the subject when there is one — for example
`08-04_14-32_project-product-zh-CN`. The report goes in `report.md` inside it.
Put every intermediate file in a `scratch/` subdirectory of the same run, and
delete `scratch/` once the report is written and the audit has passed.

## 2 — Read three files, then the base

The contracts live in this repository. Read them at these paths, in this order:

1. `engine/contracts/kb/reading-the-kb.md` — how to read the base.
2. `engine/contracts/report/writing-rules.md` — how to write and how to
   investigate, including the checklist and the closing block.
3. `engine/contracts/report/specs/<specId>.md` — the chapters this report has,
   and what belongs in each.

**MUST NOT** read the other spec. **MUST NOT** read the analysed project's source,
under any circumstance — this is the one rule whose violation invalidates the whole
run, because a report that sometimes reads source is no longer reproducible, no
longer auditable, and no longer cheaper than reading the code.

Then query the base with `sqlite3 -readonly <kbPath>`. Never open it for writing:
it is the one artefact everything here depends on, and rebuilding it costs a full
analysis run.

## 3 — Census, then investigate

Both passes are defined in `reading-the-kb.md`. Do them in order and do not skip
the second: the census gives you the shape, the investigation gives you the
findings. A report built from the census alone is a table of contents with numbers
in it — that is measured, not a worry. The run that wrote the longest report from
the fewest queries was the one that fabricated.

Work the checklist item by item. Each ends in one of three verdicts — hit,
searched-and-not-found, or cannot-be-determined-here — and **every item MUST
appear in the closing block with its verdict**, including the ones that found
nothing.

## 4 — Write the report

Write it to `report.md`, in `language`, covering every chapter the spec numbers,
in its order. `writing-rules.md` governs how; the spec governs what. Neither is
restated here — read them.

End with the machine-readable block `writing-rules.md` specifies: each checklist
item's id, its verdict, and the identities behind it.

## 5 — Audit it

```
pnpm audit:report -- <run directory>/report.md --db <kbPath>
```

The audit checks every identity the closing block names against the base, every
cited path against the files that were read, and every proportion against a
quantity the base can justify. It writes `audit.json` beside the report.

**A report with no passing `audit.json` beside it is not a deliverable**, whatever
the report says about itself. If the audit fails, report what it found and what
you would change — do not quietly rewrite and re-run until it passes, because a
report edited to satisfy a check is no longer evidence of anything.

This step is not optional and its verdict is not yours to overrule. The three
trial artefacts were indistinguishable by appearance; the fabricated one was just
as well formatted and complete. Only pulling each statement back to the base
separated them.

## Before you finish

- [ ] Every chapter the spec numbers is present, in the spec's order.
- [ ] Every checklist item appears in the closing block with one of the three verdicts.
- [ ] Every `unavailable` item is stated, not silently dropped.
- [ ] Every coverage figure carries its denominator.
- [ ] No table name, enum value or code spelling left untranslated in the body.
- [ ] `scratch/` is gone; nothing of yours sits outside the run directory.
- [ ] The audit ran, and you are reporting its verdict rather than your own.
- [ ] You did not read the analysed project's source.

Then report the run directory, the audit verdict, and how many queries you issued.
