---
id: contract
kind: shared-writing-contract
version: 2.0.0
---

# Shared writing contract

All output specs inherit this file. Change it once and every spec follows.

This file governs **how to write**; each spec governs **what to write**. Where they conflict, this file wins.

Requirement levels follow RFC 2119: **MUST** / **MUST NOT** / **SHOULD** / **MAY**.

This contract is written in English so that it does not bias the report toward any
particular output language. The report is written in the requested target language;
this contract never is.

## 1. Evidence markers

| Marker | Meaning | How it is checked |
| -- | -- | -- |
| `fact` | Directly supported by source | Every instance traces to a file and line |
| `verified` | A hypothesis checked against the fact store | The code decides the verdict; the checked locations are listed |
| `inferred` | What the cited facts mean, in business terms | The facts it rests on are listed; a reader can disagree with the reading |
| `unavailable` | Static analysis cannot answer it | Stated explicitly — never guessed, never left blank |

**These four and no others.** Every sentence either points at evidence or is marked unavailable.

Markers are structural tokens, not printed English. The View renders each one into
the target language. Reference renderings:

| Token | zh-CN | en |
| -- | -- | -- |
| `fact` | 事实 | Fact |
| `verified` | 验证 | Verified |
| `inferred` | 推断 | Inferred |
| `unavailable` | 不可得 | Unavailable |

### What `inferred` is for

A report that only lists facts does not tell the reader what they are looking at.
"Twenty-five endpoints write to four tables" is true and useless on its own;
"this module handles leave requests from submission through multi-level approval"
is what makes the rest legible. That reading is an inference, it is marked as one,
and it is required — a report that refuses to say what a system does has not done
its job.

An inference **MUST** stay on the "what is this" side:

| Allowed | Not allowed |
| -- | -- |
| What the system or module does | What ought to be done about it |
| What a table or field represents | What might go wrong because of it |
| Which business activity a flow implements | Why it was built this way |
| Who a role appears to serve | Whether the design is good |

Every inference **MUST** name the facts it reads. "This module handles leave
approval `inferred`, from the four approval-level guards and the leave tables it
writes" is an inference a reader can check and disagree with. The same sentence
with nothing behind it is a guess.

Prefer `fact` where a fact will do. Reach for `inferred` when the reader needs the
meaning, not when a fact is inconvenient to find.

**Translating a term is not inference.** Rendering `wcp_leave` as "leave record", or a `CheckIsHR` guard as "accessible to HR specialists", swaps a technical identifier for readable wording without adding information — it stays `fact`. Reports **MUST** do this. A report that dumps table and function names is not acceptable.

## 2. Describe the present; do not prescribe or predict

Say what the system is and what it does — that is the report's purpose. Do not say
what should be done about it, what it might cause, or why it came to be this way.

**These five categories MUST NOT appear:**

| Category | Example |
| -- | -- |
| Design intent or rationale | "this was designed to support multi-tenancy", "this is legacy" |
| Motive or background speculation | "the team is probably mid-migration", "this looks unmaintained" |
| Consequence speculation | "this could cause data inconsistency", "users might double-submit" |
| Solutions | recommendations, acceptance criteria, action items, priority ordering |
| Evaluation without evidence | "tightly coupled", "poorly designed" |

The line runs between **what this is** and **what to do about it**. Reading a
business meaning off the facts is the first; advice, prediction and motive are the
second. Source code records what was built, not why it was built or what it will
cause, and the reader — who knows the schedule, the team and the constraints — is
the one placed to judge those.

**A precisely stated fact carries its own weight.** "The leave notification call's error is discarded — neither logged nor retried" is complete. Appending "so operations cannot diagnose it" adds nothing and crosses the line.

## 3. What the opening must declare

* **Analysis scope**: which source roots were read. A module report additionally states which code the module comprises, which repositories it spans, and how that boundary was determined.
* **Method**: static source review only; dependencies not installed, services not started, database not connected, tests not executed, production traffic not traced.
* **Evidence levels**: the four markers from section 1.
* **Snapshot**: each repository's revision, whether it had uncommitted changes, and the analysis time.

The opening **MUST** describe the subject. It **MUST NOT** open with a description of the analysis method. Chapter introductions address the reader and **MUST NOT** explain how the analyzer works.

## 4. Every chapter needs a closing summary

After listing its facts, each chapter closes with one or two sentences that **generalize** them into a single statement.

The summary **MUST** be a roll-up of facts already listed in that chapter. It **MUST NOT** introduce a new conclusion and **MUST NOT** extrapolate consequences.

* Acceptable: "Two of the five repositories both write to the leave tables."
* Not acceptable: "This risks data inconsistency, so the writers should be consolidated."

A chapter that only lists facts, with no generalization, is incomplete. The report is a document with a thesis, not a list of answers — the chapters must connect.

## 5. The problems-and-risks chapter

**Group by how each finding was determined.** Every entry gives the **basis for the determination** and the **exact location**.

* **MUST NOT order by priority.** The same situation matters differently in different business contexts; the reader orders it.
* **MUST NOT propose solutions.**
* **MUST NOT include an "impact" paragraph.** Consequences are speculation.
* Every determination **MUST** rest on the project contradicting itself or lacking something. It **MUST NOT** cite external best practice.
* The analyzer's own coverage gaps **MUST NOT** appear here; they belong in the coverage chapter.

## 6. The hypothesize–search–decide loop

Anything marked `verified` is produced by this loop:

```
1. From the objects and states at hand, state the rule you expect to exist
2. Search the validation, condition and permission facts in that scope
3. Let the code decide, three ways:
   hit                        -> not a problem
   miss, coverage complete    -> an evidenced absence; list the checked locations
   miss, coverage incomplete  -> unconfirmed; say where the gap is
```

* Expected rules **MUST** be derived on the spot from the current project's objects and states. They **MUST NOT** be hardcoded as a fixed list for a particular business.
* A fixed list of business-agnostic failure modes (empty data, double submission, concurrent modification, timeout, and so on) **MAY** be used.
* The report **MUST** state which locations were checked.
* All three outcomes **MUST** appear in the report. Reporting only the misses leaves the reader unable to judge the overall picture.

## 7. Glossary

| Code identifier | Business name (source language) | Target-language rendering |
| -- | -- | -- |

All three columns **MUST** be present. The body uses the target language; the glossary keeps all three layers — otherwise the reader cannot map back to the code, nor talk to a team working in another language. Abbreviations **MUST** be given with their expansions.

## 8. The coverage chapter

* Every metric **MUST** carry its denominator. "Some call chains could not be resolved" is not acceptable; "18% (93/520) of call chains terminated early" is.
* The chapter **MUST** include a "questions this report does not answer" table, naming the data source to consult for each. Readers will look for these; saying plainly "not covered here, look there" is worth more than stitching a guess out of code traces.
* This chapter describes **the boundary of the analysis**, not a problem with the project. The two **MUST NOT** be mixed into the problems-and-risks chapter.

## 9. The unsafe-assumptions chapter

The wrong conclusions a reader is most likely to draw from this report. Each entry is phrased as "fact X does not mean conclusion Y", with the reason.

Each entry **MUST** correspond to a statement that actually appears in this report. Generic disclaimers **MUST NOT** be written.

## 10. Diagrams

* Diagrams **MUST** be written as Mermaid, in a fenced ` ```mermaid ` block. It is
  the form a reader can follow in the source, edit by hand, and diff between runs
  — none of which holds for a wall of SVG path data.
* Rendering to a portable format for DOCX and PDF is the engine's job, from that
  Mermaid source. A spec **MUST NOT** ask the author to emit SVG.
* Branch and state labels in diagrams **MUST** use the target language and **MUST NOT** expose the code's own enum spellings.

## 11. Structural requirements

1. Evidence (file paths, line numbers, code identifiers) is collapsed by default and **MUST NOT** sit in the reading flow. Formats without collapsible regions move it to footnotes or an appendix.
2. Every `unavailable` item **MUST** be stated explicitly and **MUST NOT** be silently omitted.
3. Internal enum values, table names and code spelling variants **MUST NOT** appear untranslated.
4. A role is named once, readably; the code's spelling variants belong in the evidence layer. A role **MUST NOT** be described as "referenced in N permission checks" — that is a code statistic, not information.
5. Facts shared across reports **MUST** carry the same fact id, and the reports **MUST NOT** describe them in contradictory ways.
6. Two runs over the same snapshot **MUST** produce claim sets that overlap above the agreed threshold.

## 12. Claim constraints

Each conclusion in the report becomes one claim. A claim's identity is its **predicate and subject**.

* A claim **MUST NOT** exist without factIds. A claim with no references is invalid.
* A claim's statement **MUST** be structured. It **MUST NOT** be a finished sentence in any language, or language independence does not hold.
* Variable quantities (counts, lists, verdicts) **MUST** live in qualifiers and **MUST NOT** enter the identity.
* An aggregate conclusion ("N occurrences in total") **MUST NOT** be emitted as its own claim. It is a roll-up over the claims sharing that predicate, and its number is the cardinality of that set.

Rationale: `docs/pi-110-claim-identity-verification.md`.
