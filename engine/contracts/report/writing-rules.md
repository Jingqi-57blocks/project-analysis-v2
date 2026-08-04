---
id: writing-rules
kind: shared-writing-rules
version: 3.1.0
---

# Writing rules

Every output spec inherits this file. It governs **how to write** and **how to
investigate**; a spec governs **what to write** — its chapters, and what belongs in
each.

**A spec MUST NOT restate a rule from this file.** Restating is how the two drift
into contradicting each other, and a reader following the spec then breaks a rule
while obeying it. Where they nonetheless appear to conflict, this file wins.

This file is written in English so it does not bias the report toward any output
language. The report is written in the requested target language; this file never is.
Requirement levels follow RFC 2119.

---

# Part 0 — Evidence-safe language

Static source review shows what the reviewed code contains and which paths appear
possible. It does not by itself establish production usage, current configuration,
runtime traffic, business ownership, or what actually happens when the system runs.

Almost every wrong sentence in a report of this kind comes from crossing that line
in one of a small number of ways. These rules close them:

| The base holds | It does **not** hold |
| -- | -- |
| A count of observed call sites | Traffic, usage, or how often anything runs |
| A registered entry point | That anyone calls it, or that it is live |
| A registered scheduled job | That it currently runs, or succeeds |
| A configuration switch in source | Its value in production |
| Which parts read and write some data | Who owns it, or which copy is authoritative |
| That data is available to a process | That it alone determines the result |
| No caller found | That there is no caller — only that none is in the analysed scope |
| No validation found | That the rule is absent — only that it is not in the reviewed paths |
| No retry in application code | That nothing retries; SDKs, gateways and infrastructure are invisible here |
| No organisation filter in reviewed paths | That the deployed system serves one organisation |

**Verbs carry claims.** "Becomes", "determines", "always", "all", "only" and "every"
assert exhaustiveness, and the base almost never proves it. Approved work records
*may contribute to* a billing calculation; a performance process *may reference*
project participation. Write the relationship the source supports, not a causal
chain from one end of the business to the other. Reach for "may", "is likely to" or
"the reviewed path suggests" whenever the consequence is inferred rather than read.

**Counts are of what was observed.** Any number the report gives is a count of rows
in the base. Where that number could be mistaken for a runtime quantity — calls,
usage, volume — say what was counted: "309 call sites resolved to it", never "309
calls".

## The visible report speaks business language

Repository names, entry-point paths, class and function names, table names, source
paths, enum members and role codes belong **only** in the collapsed evidence block —
including in chapter titles and table headers — unless the technical name is itself
what the business calls the thing.

This is not a matter of taste. A reader who cannot tell what an identifier means
cannot tell whether the sentence containing it is true, and a paragraph carrying
three of them reads as machine output however carefully the sentence was written.

---

# Part I — How to write

## 1. Evidence markers

| Marker | Meaning | How it is checked |
| -- | -- | -- |
| `fact` | Directly supported by the base | Every instance traces to a file and line |
| `verified` | A hypothesis searched for and decided by the code | The searched rows are named |
| `inferred` | What the cited facts mean, in business terms | The facts it rests on are listed; a reader may disagree |
| `unavailable` | Static analysis cannot answer it | Stated explicitly — never guessed, never blank |

**These four and no others.** Every sentence either points at evidence or is marked
`unavailable`.

The names above are structural tokens for this document, not words for the report.
Every one of them **MUST** be rendered into the target language; a report carrying
the token as written here has left this contract's scaffolding in the reader's way.

The same applies to the one fixed lead-in the chapters share. Renderings:

| Token | zh-CN | en |
| -- | -- | -- |
| `fact` | 事实 | Fact |
| `verified` | 验证 | Verified |
| `inferred` | 推断 | Inferred |
| `unavailable` | 不可得 | Unavailable |
| the synthesis lead-in | 这意味着什么 | What this means |

A language not listed takes the reading that language's own business writing would
use; the point is that the reader never meets a token from this file.

## 2. Say what things are

A report that only lists facts does not tell the reader what they are looking at.
"Twenty-five endpoints write to four tables" is true and useless alone. What makes
the rest legible is the sentence that says what the system does — and that sentence
is an inference, is marked as one, and is **required**. A report that refuses to say
what a system does has not done its job.

An inference **MUST** stay on the "what is this" side:

| Allowed | Not allowed |
| -- | -- |
| What the system or a part of it does | What ought to be done about it |
| What a stored object or field represents | Why it was built this way |
| Which business activity a flow implements | Whether the design is good |
| Who a role appears to serve | What the team was probably thinking |

Every inference **MUST** name the facts it reads. Prefer `fact` where a fact will do;
reach for `inferred` when the reader needs the meaning, not when a fact is
inconvenient to find.

**Translating a term is not inference.** Turning a table identifier into "leave
record", or a role-check function into "accessible to HR specialists", swaps a
technical identifier for readable wording without adding information — it stays
`fact`, and reports **MUST** do it. A report that prints raw table and function names
is not acceptable.

**These MUST NOT appear:** design intent or rationale; motive and background
speculation; solutions, recommendations or action items; evaluation without evidence.
A precisely stated fact carries its own weight.

Consequences are constrained rather than banned — see Part III, risk format.

## 3. How it must read

* **Open with one sentence.** The way one sentence explains a marketplace: *sellers
  list products and buyers order them, with payment and delivery handled in between.*
  No jargon, no hedging. If the evidence will not support a sentence that confident,
  write the most confident one it does support and say what is missing.
* **Never write a file path, a table name, an endpoint path, a repository name or a
  code identifier where a plain description will do.** "The web application people
  use" beats a repository identifier; "human resources" beats an enum member spelled
  `HRC`. Where a part's name is genuinely how people refer to it, use it once and
  move on. Identifiers belong in the evidence layer and the glossary.
* **The analysis's own vocabulary never appears in the body.** The names of fact
  kinds — and every other word that exists because of how the base is organised —
  are how the analyser talks to itself. A sentence that has to name one has not
  finished being written.
* **Counts of code artifacts are not facts about the business.** How many endpoints,
  tables, entities, modules, routes or repositories exist tells a business reader
  nothing they can act on, and reads as substance while carrying none. Where the size
  of something matters, count what the reader recognises: kinds of user, areas of the
  business, steps in a flow. Coverage figures in the final chapter are the exception,
  because measuring the analysis is that chapter's subject.
* **Do not describe the analysis.** The reader wants the system, not the tool that
  read it. The opening **MUST** describe the subject and **MUST NOT** open with
  method. Coverage and method have their own chapter at the end.
* **Quote the project's own words** where it has any — `readme-section` and
  `project-title` in `evidence_items`. Where it carries no description, say so; that
  is a fact about the project, and a substitute you invent is not.
* **Give each sub-question a bolded lead-in.** A chapter of undifferentiated
  paragraphs forces the reader to read all of it or none. The lead-ins are what let
  someone skim to the one thing they came for, and what stops the chapter drifting
  into an essay.
* **Every chapter closes with a synthesis, under its own lead-in.** Two or three
  sentences saying what this chapter's facts mean **for reading the rest of the
  report**: not a recap, and not a list. "Five repositories are not five businesses —
  they are one front end, one shared database and four back ends, so the blast radius
  of any change is never confined to the repository it lands in" is a synthesis. "The
  project has five repositories" is a recap, and writing one is the same as writing
  nothing.

  The synthesis **MAY** state what follows for the reader from the facts in that
  chapter. It **MUST NOT** recommend an action, predict an outcome, or reach for a
  fact the chapter did not establish. The line is between "here is what this means"
  and "here is what you should do".

## 4. Structure

1. **No code in the body. None.** File paths, line numbers, table names, function
   names, enum members, entry-point paths and identity strings **MUST NOT** appear in
   the reading flow — not in a sentence, not in a parenthesis, not in a table cell.
   The reader cannot tell what they mean, and a paragraph carrying three of them
   reads as machine output however good the sentence around them is.

   All of it goes in a collapsed `<details>` block at the end of the section it
   supports. Every section that makes an evidenced statement has one.

   Where a marked statement needs its grounds visible, the parenthesis carries the
   **reasoning, in words** — "推断，依据：评审服务的 README 自述，以及工时、账单、
   绩效共用同一批员工与项目档案" — and the identifiers behind that reasoning sit in
   the collapsed block. A parenthesis that has become a list of identity strings has
   taken the evidence layer's job and put it in the reader's way.

   The exception is the glossary, whose subject is the mapping itself.
2. **Punctuation follows the output language.** A report in Chinese uses full-width
   punctuation throughout; one in English uses ASCII. Mixing them is the most visible
   way a document reads as machine-written, and it costs nothing to get right.
3. Every `unavailable` item **MUST** be stated explicitly, never silently dropped.
4. Every coverage figure **MUST** carry its denominator, written as `N% (n/d)` with
   the percent sign immediately before the bracket. "Some call chains could not be
   resolved" is not acceptable; "18% (93/520) terminated early" is; "18% of call
   chains (93/520)" is **not** — a noun between the sign and the bracket makes the
   figure unverifiable, and a report written that way had every one of its coverage
   numbers pass unchecked. The denominator **MUST** be a quantity one aggregate over
   the base produces, never a sum you computed.
5. A role is named once, readably. **MUST NOT** describe a role as "referenced in N
   permission checks" — that is a code statistic, not information.
6. Diagrams **MUST** be Mermaid in a fenced ` ```mermaid ` block, never hand-written
   SVG. Branch and state labels use the target language and **MUST NOT** expose the
   code's enum spellings.
7. The glossary carries three columns — code identifier, business name in the source
   language, target-language rendering — and every abbreviation its expansion.
8. The coverage chapter describes **the boundary of the analysis**, not a problem
   with the project. The two **MUST NOT** be mixed.

---

# Part II — The investigation

The census establishes the shape. It finds nothing. Every finding worth reading comes
from stating a hypothesis and searching for it.

## Checklist

A floor, not a ceiling. Each item **MUST** carry exactly one verdict in
`checklist.json`: **hit** / **searched, not found** (name the rows searched) /
**cannot be determined here** (the kind is empty in this project). Items marked
*multi-root* apply only when the workspace has more than one root, and are not
required of a single-root project.

Every item gets a verdict, including the dull ones. A dropped item and one that
searched and found nothing are indistinguishable afterwards, which is the whole
reason the file exists.

**A `searched, not found` verdict is not a defect.** It says the rule was not found
in the paths this analysis covers. The rule may live in a database constraint, a
gateway, a framework default, a dependency, runtime configuration, or a call chain
the analysis could not follow. Report it as a coverage gap or a question to settle,
never as an established absence.

| id | Hypothesis | Where to search |
| -- | -- | -- |
| `literal-secrets` | Keys or credentials written as literals in source | `value-set`, `entity-field`, `config-key` |
| `rule-boundary-differs` | The same rule enforced with different boundaries in different parts *(multi-root)* | `business-rule` grouped by subject across roots |
| `guard-polarity` | Equivalent permission checks written inconsistently | `guard`, grouped by called predicate, negations compared — see `reading-the-kb.md` |
| `literal-identifiers` | Business rules comparing against literal identifier constants | `business-rule` literals |
| `discarded-errors` | Errors neither logged nor reported | `discarded-error` |
| `uncalled-entries` | Entry points nothing in the workspace calls | `feature-finding`, `unlinked-call` |
| `unauthenticated-entries` | Entry points with no authentication observed | `feature-finding` |
| `shared-storage` | One stored object written by several parts, read across a boundary, or declared with different shapes *(multi-root)* | `structural-finding` |
| `deprecated-or-unfinished` | Work explicitly marked deprecated, unfinished or to-do | `doc-comment` |
| `feature-switches` | Capabilities gated by configuration | `config-key` |
| `external-call-in-transaction` | An external call made inside a transaction | `transaction-boundary` × `outbound-call`, line ranges intersected |
| `open` | Any hypothesis the facts themselves suggest | Anywhere |

`open` is not optional and is not a formality. A report whose every finding came from
the eleven named items has executed a checklist, not investigated. **At least one
finding MUST come from `open`, and MUST NOT be a row that `structural-finding`
already computed.**

The business-agnostic failure modes — empty input, invalid input, double submission,
concurrent modification, timeout, partial success, boundary values — are searched the
same way wherever a spec's chapters call for them.

## Risk format

Every entry in a risks chapter rests on the project contradicting itself or lacking
something. It **MUST NOT** cite external best practice. The analyser's own coverage
gaps belong in the coverage chapter, never here. Group entries by how each was
determined.

Each finding carries three parts and no others:

**Evidence** `fact` — what the code says, with its exact location.

**What it permits** `inferred` — a first-order restatement of what the evidence allows
to happen, in terms the reader understands. "Any signed-in user can read another
employee's review records" restates a missing negation; it does not predict. Second-
order prediction — that data will corrupt, that users will lose trust, that an
incident will follow — **MUST NOT** be written.

**Priority** — `P0` / `P1` / `P2`, from two questions and nothing else:

| | Touches money, permissions or sensitive data | Does not |
| -- | -- | -- |
| **No protection currently present** | P0 | P1 |
| **Some protection present** | P1 | P2 |

**Confidence** — stated separately, and never folded into the priority:

| Value | When |
| -- | -- |
| confirmed | The reviewed source establishes both the defect and a path that reaches it |
| strongly supported | The defect is established; whether anything reaches it is not |
| requires validation | Part of the finding rests on a path the analysis could not follow |

A large potential impact does not by itself make something P0. `P0` requires a
reachable path **and** a credible immediate effect. Where reachability is
`unavailable`, say what would have to be true, and do not write the scenario as
though it were established.

**MUST NOT** propose remediation, acceptance criteria or action items. What to do
about it is the reader's call.

## The checklist file

The checklist's verdicts are **not** part of the report. A business reader has no use
for them, and a document that ends in a wall of machine identifiers reads as a data
dump whatever the chapters before it say.

Write them instead to `checklist.json`, beside `report.md` in the run directory:

```json
{
  "checklist": [
    { "id": "literal-secrets", "verdict": "hit", "evidence": ["<fact id>", "..."] },
    { "id": "feature-switches", "verdict": "searched-not-found", "evidence": ["<fact id>"] },
    { "id": "external-call-in-transaction", "verdict": "cannot-determine", "evidence": [] }
  ]
}
```

`verdict` is one of `hit`, `searched-not-found`, `cannot-determine`. `evidence` holds
the identity values as they appear in the base — `record_key` for
`structural_records` and `derived_records`, `fact_id` for `behavior_facts`,
`item_key` for `evidence_items`. Every id is checked against the base by the audit, so
an id that was not actually read will be caught. Only `cannot-determine` may carry an
empty list.

An identity is **copied**, never retyped or tidied. Trailing empty segments are
common and part of the value — `...|219|1|` ends in an empty segment and trimming it
produces a string the base does not contain.

The findings themselves still belong in the report, in the risks chapter, written as
prose for a reader. This file is the audit's input, not the reader's.
