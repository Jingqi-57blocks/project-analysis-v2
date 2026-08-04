---
id: writing-rules
kind: shared-writing-rules
version: 1.0.0
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

# Part I — How to write

## 1. Evidence markers

| Marker | Meaning | How it is checked |
| -- | -- | -- |
| `fact` | Directly supported by the base | Every instance traces to a file and line |
| `verified` | A hypothesis searched for and decided by the code | The searched rows are named |
| `inferred` | What the cited facts mean, in business terms | The facts it rests on are listed; a reader may disagree |
| `unavailable` | Static analysis cannot answer it | Stated explicitly — never guessed, never blank |

**These four and no others.** Every sentence either points at evidence or is marked
`unavailable`. Markers are structural tokens; render each into the target language
(`fact` → 事实 / Fact, `verified` → 验证 / Verified, `inferred` → 推断 / Inferred,
`unavailable` → 不可得 / Unavailable).

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
* **Never write a file path, a table name, an endpoint path, or a repository name
  where a plain description will do.** "The web application people use" beats a
  repository identifier. Where a part's name is genuinely how people refer to it, use
  it once and move on. Identifiers belong in the evidence layer and the glossary.
* **Do not describe the analysis.** The reader wants the system, not the tool that
  read it. The opening **MUST** describe the subject and **MUST NOT** open with
  method. Coverage and method have their own chapter at the end.
* **Quote the project's own words** where it has any — `readme-section` and
  `project-title` in `evidence_items`. Where it carries no description, say so; that
  is a fact about the project, and a substitute you invent is not.
* **Every chapter closes with a short synthesis** that generalizes that chapter's own
  facts into one or two sentences. It **MUST NOT** introduce a new conclusion. A
  chapter that only lists facts is incomplete — this is a document with a thesis, not
  a list of answers.

## 4. Structure

1. Evidence — paths, line numbers, identifiers — is collapsed by default and **MUST
   NOT** sit in the reading flow.
2. Every `unavailable` item **MUST** be stated explicitly, never silently dropped.
3. Every coverage figure **MUST** carry its denominator. "Some call chains could not
   be resolved" is not acceptable; "18% (93/520) terminated early" is.
4. A role is named once, readably. **MUST NOT** describe a role as "referenced in N
   permission checks" — that is a code statistic, not information.
5. Diagrams **MUST** be Mermaid in a fenced ` ```mermaid ` block, never hand-written
   SVG. Branch and state labels use the target language and **MUST NOT** expose the
   code's enum spellings.
6. The glossary carries three columns — code identifier, business name in the source
   language, target-language rendering — and every abbreviation its expansion.
7. The coverage chapter describes **the boundary of the analysis**, not a problem
   with the project. The two **MUST NOT** be mixed.

---

# Part II — The investigation

The census establishes the shape. It finds nothing. Every finding worth reading comes
from stating a hypothesis and searching for it.

## Checklist

A floor, not a ceiling. Each item **MUST** appear in the report with exactly one
verdict: **hit** / **searched, not found** (name the rows searched) / **cannot be
determined here** (the kind is empty in this project). Items marked *multi-root* apply
only when the workspace has more than one root.

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

**MUST NOT** propose remediation, acceptance criteria or action items. What to do
about it is the reader's call.

## The closing block

The report ends with a fenced ` ```json ` block, after the last chapter, listing every
checklist item:

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
