---
name: project-report
description: Write a source-understanding report from a bounded fact pack — fact pack → claims → view. Use when asked to generate a project overview or module detail report from an analysis snapshot. Never reads the analysed project's source.
---

# Project report

You turn a **bounded fact pack** into a report, in two steps and no others:

```
fact pack  ──▶  claims  ──▶  view
              (language-      (one audience,
               independent)    one language)
```

Slicing, auditing and rendering happen outside you. You do not choose what to
read, you do not decide whether the report ships, and you do not produce HTML.

## ACTION REQUIRED

Reading this file is not the task. **Begin at step 1 now.** Do not reply with a
summary of what you are about to do; produce the artefacts.

You are given, in the invocation:

| Input | Meaning |
| -- | -- |
| `phase` | `claims` or `chapter` — which half of the work this call performs |
| `packPath` | JSON fact pack index — the whole of what is knowable here |
| `specId` | Which output spec governs this report |
| `language` | The target language of the view |
| `claimsPath` | The claim set: written in the `claims` phase, read in the `chapter` phase |
| `scratchPath` | Where every intermediate file goes |

A `chapter` call additionally carries `chapterNumber`, `chapterTitle`,
`chapterOutputPath`, and that chapter's own part of the spec inline.

If any is missing, stop and say which. Do not guess a default.

**Every file you write that is not an output goes under `scratchPath`.** Helper
scripts, partial results, notes — all of it, and nothing outside it. A run that
scatters intermediates leaves them behind forever, because nobody knows which
files were yours. The engine deletes `scratchPath` once the run has produced its
report, and keeps it when the run fails, so a failed run stays diagnosable.

**Do exactly your phase's work and nothing else.** A `claims` call writes the claim
set and stops. A `chapter` call writes one chapter and stops. Chapters are
authored concurrently by separate calls; writing a neighbour's chapter, or the
assembled report, would collide with another call in flight. The engine
assembles the chapters in spec order.

## NOW — load exactly four things

**MUST** read, in this order:

1. `engine/contracts/kb/kb-contract.md` — how to read the pack.
2. `engine/contracts/report/specs/contract.md` — the shared writing contract.
3. `engine/contracts/report/specs/<specId>.md` — the one spec that governs this report.
4. The pack at `packPath`.

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

## ACT — produce claims, then the view

### Phase `claims` — the claim set

Every conclusion becomes one claim:

```json
{
  "predicate": "table-written-by-multiple-services",
  "subject": { "type": "entity", "ref": "<stable reference>" },
  "qualifiers": { "writers": ["…"] },
  "factIds": ["<pack row key>", "…"]
}
```

* **MUST NOT** emit a claim with no `factIds`. That is the only thing separating
  a claim from a sentence you made up.
* **MUST NOT** write a `claimId`. Identity is a function of the predicate and the
  subject, and the engine computes it — writing one out only creates a second
  version that can disagree with the first.
* `predicate` **MUST** be a lowercase token (`table-written-by-multiple-services`),
  never a sentence. It is language-independent; the view is where language enters.
* `subject` **MUST** come from the pack's `subjects` list. Facts of a
  line-anchored kind (`condition`, `guard`, `call-edge`, `data-access`,
  `decision`, `error-handling`, `outbound-call`, `discarded-error`,
  `auth-annotation`, `value-set`) cite freely as evidence but **MUST NOT** be the
  thing a claim is about — their identity contains a file line and moves on
  unrelated edits.
* Variable content (counts, lists, verdicts) goes in `qualifiers`, never in the
  predicate or subject.
* **MUST NOT** emit an aggregate claim. "7 tables are written by more than one
  service" is not a claim; it is the count of the claims sharing that predicate,
  and the renderer computes it. Emit the seven.

Write the claim set to `claimsPath` as `{"claims":[…]}`.

### Phase `chapter` — one chapter

Read the claim set at `claimsPath`, then write **only your chapter** to
`chapterOutputPath`, in `language`, following the part of the spec given inline
and the shared contract's rules. Open with the chapter's own `##` heading.

**Read the claim set. Do not open the pack.** The claims phase already walked it,
once, so that this phase does not have to — twelve chapters each exploring the
same pack would cost twelve times what walking it once cost, and the claim set
exists precisely so that work is done and shared. If a claim's wording is
unclear, write from what the claim says; do not go back to the facts behind it.

Every statement traces to a claim; every claim traces to fact ids. A conclusion
that is not already a claim does not belong in a chapter — the other chapters
cannot see it, and consistency rests on the shared set.

The rules you will most easily break, restated:

* Evidence markers are `fact`, `verified`, `unavailable`. **There is no inferred
  tier.** Render the marker in the target language.
* Translating a term is not inference — a report that prints raw table and
  function names is not acceptable.
* **MUST NOT** write design intent, motive, consequences, solutions, or evaluation
  without evidence. A precise fact carries its own weight; appending what it
  might cause crosses the line.
* Every chapter closes with a summary that **generalizes** the chapter's own
  facts and introduces nothing new.
* Every coverage number carries its denominator.
* Diagrams are SVG; branch labels use the target language, never the code's enums.

## Before you finish

Check each, and fix what fails:

- [ ] Every kind in `requires` was opened, and every zero-row kind is reported.
- [ ] Every claim has at least one factId.
- [ ] No claim's subject is a line-anchored fact.
- [ ] No aggregate was emitted as a claim.
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
