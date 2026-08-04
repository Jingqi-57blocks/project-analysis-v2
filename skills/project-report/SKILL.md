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
| `runId` | the sole published run in the base |

If `feature-product` was asked for with no subject, stop and ask which capability.
Do not pick one.

If the base holds more than one workspace and no `runId` was given, stop and ask
which run. A report about the wrong project is indistinguishable from a report
about the right one.

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
delete `scratch/` once the report is written and the audit has passed — but copy
`scratch/queries.log` next to the report first, since it is the evidence of how the
report was reached.

## 2 — Read three files, then the base

They sit beside this one, in `references/`, and are read in this order:

1. `references/reading-the-kb.md` — how to read the base.
2. `references/writing-rules.md` — how to write and how to investigate, including
   the checklist and the file of verdicts.
3. `references/<specId>.md` — the chapters this report has, and what belongs in
   each.

**MUST NOT** read the other spec. **MUST NOT** read the analysed project's source,
under any circumstance — this is the one rule whose violation invalidates the whole
run, because a report that sometimes reads source is no longer reproducible, no
longer auditable, and no longer cheaper than reading the code.

Then query the base with `pnpm kb:query`, as `reading-the-kb.md` shows. It opens the
base read-only, binds every query to one published snapshot, and logs what you asked.
Never open the base for writing: it is the one artefact everything here depends on,
and rebuilding it costs a full analysis run.

Before the census, write `manifest.json` in the run directory — the snapshot this
report is about, in the shape `reading-the-kb.md` gives. The audit will not run
without it.

## 3 — Census, then investigate

`pnpm kb:query --log <run directory>/scratch/queries.log` records each query as you
run it. The count is how anyone later tells an investigation from a census, and
reconstructing it afterwards is guesswork.

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

The findings go in the report, as prose. The checklist's verdicts do not — write
those to `checklist.json` beside it, in the shape `writing-rules.md` gives. That file
is the audit's input; the report is the reader's.

Some hosts refuse the `Write` tool for a file they recognise as a report, with a
message about returning findings as text. That guard is about a subagent's reply, not
about this deliverable. Write the file with a shell heredoc instead and carry on.

## 5 — Audit it

```
pnpm audit:report <run directory>/report.md --db <kbPath>
```

It reads `manifest.json`, re-resolves that snapshot from the base and refuses if
the two disagree. Then it checks every identity the closing block names against
the base, every cited path against the files that were read, and every proportion
against a quantity the base can justify. It writes `audit.json` beside the report.

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
- [ ] `checklist.json` sits beside the report, with all twelve verdicts.
- [ ] No file path, table name, identifier or identity string is in the report body — all of it is inside collapsed evidence blocks. The glossary is the exception; its subject is the mapping.
- [ ] Every `unavailable` item is stated, not silently dropped.
- [ ] Every coverage figure carries its denominator.
- [ ] No table name, enum value or code spelling left untranslated in the body.
- [ ] `queries.log` was kept, and you are reporting its line count.
- [ ] `scratch/` is gone; nothing of yours sits outside the run directory.
- [ ] The audit ran, and you are reporting its verdict rather than your own.
- [ ] You did not read the analysed project's source.

Then report the run directory, the audit verdict, and how many queries you issued.
