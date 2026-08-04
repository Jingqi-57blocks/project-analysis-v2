---
id: project-product
scope: project
audience: product
version: 5.0.0
title: Project overview, non-technical
---

# Project overview, non-technical

> Audience: product managers, business owners, operations leads, project managers.
> Goal: without reading code, be able to say what this project is, what it can do,
> how those capabilities relate, and what is wrong with it.

How to write and how to investigate: `engine/contracts/report/writing-rules.md`.
This spec defines only the chapters and what belongs in each.

# Chapters

Ten, in this order, numbered. No tier headings above them — the numbering is the
only structure the reader needs.

Every chapter is built the same way:

1. a short paragraph answering the chapter's question;
2. **bolded lead-ins** naming each sub-question below it;
3. **a last lead-in that is the chapter's synthesis** — two or three sentences on
   what this chapter's facts mean for reading the rest of the report;
4. the collapsed evidence block.

Step 3 is a lead-in like the others, and it is repeated at the foot of every chapter
below for that reason: as a general instruction it gets dropped. One run wrote it in
nine chapters of eleven; the next, under the same general rule, wrote it in none. It is the difference between a document that argues something and one that
answers questions, and nothing downstream can detect its absence — a chapter closing
on "**Project stage** — unavailable" looks identical to one closing on a synthesis.

The lead-ins are also what let a reader skim to the one thing they came for; a
chapter of undifferentiated paragraphs makes them read all of it or none.

## 1. What this project is, and where its edges are

An **introduction**, not an answer sheet — the only chapter written as though the
reader has asked "what is this?" and nothing else.

**The test this chapter MUST pass:** delete every marker, parenthetical and citation.
What is left has to be something you could read aloud to a business owner who has
never heard of the project, and they would come away knowing what it does. If
deleting the evidence leaves a chapter that says nothing, it was answered, not
written.

Open with a paragraph naming **what kind of organisation runs this, what business it
is in, and which parts of that business the system holds together**. "An HR platform"
is a label, not a sentence: it fits a hundred systems. What makes a system legible is
which activities it puts in one place and what they share.

Describe the relationships the system supports; **MUST NOT** turn a data relationship
into a mandatory causal chain. Approved work records may contribute to a billing
calculation, and project participation may be referenced by a performance process —
those are relationships the base can show. That every work record becomes an invoice,
or becomes a performance record, is a transformation the base would have to prove
exhaustively, and it does not.

Then, each under its own bolded lead-in:

* **Main users** — who they are, including any outside the organisation, and what
  each comes here to do, in the words those people would use.
* **Core scenarios** — the handful of things people actually come here to do, as a
  short list.
* **What it is for** — one sentence on what having all of this in one system gets
  them.
* **Project boundary** — what is inside.
* **External boundary** — what is somebody else's system, named as capabilities
  (sign-in, file storage, mail, chat, maps, AI) rather than as vendors alone.
* **Project stage** — `unavailable`; one line, no elaboration.

Numbers here **MUST** be ones a business reader can use: how many kinds of user, how
many areas of the business. Counts of code artifacts belong in chapter 10 if
anywhere.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 2. The parts, and what each is responsible for

| Part | What it is for | Who uses it | What it carries | Notes |
| -- | -- | -- | -- | -- |

Then: **is any of them historical or being retired** — answered as `verified`, by
searching rather than by assuming from a name. A part named like an old version is a
hypothesis, not a finding: check whether anything still calls it, whether it still
writes data, and whether scheduled work still runs in it.

File counts, language breakdowns and line counts **MUST NOT** appear. Deployment and
runtime environment are `unavailable`.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 3. Business domains and capability map

```text
project
└── business domain
    └── capability
        └── what a user can do
```

Named in business terms. A directory name, route prefix or repository name appearing
as a capability is a defect — resolve it to what a user can do, or leave it out.

**Capability sources** **MUST** cover: what people use directly, what administrators
use, mobile, access by other systems and by automation, import and export,
notifications, third-party integrations, and work that runs on a schedule.

**Lifecycle markers** — the report names only the capabilities carrying one:

| Marker | Basis |
| -- | -- |
| Explicitly gated | Wrapped in a configuration-driven condition |
| Explicitly unfinished | An unimplemented branch, or a note saying so |
| Explicitly deprecated | An explicit deprecation marker |

A capability with none of these is simply not listed here. **MUST NOT** label it
"unconfirmed" or anything similar — that reads as "we are not sure this works", when
all that was established is that the reviewed source carries no lifecycle marker for
it. Say that once, in a sentence, for the group as a whole.

"In normal use", "partially used" and "used by specific customers" need runtime and
commercial information; they belong in chapter 10 and **MUST NOT** be status values.

**How the parts relate** — its own sub-section, with a diagram, under these lead-ins:
which call each other and which span more than one repository; which share a business
object and which is read or written by more than one part; which one the most others
depend on. Internal steps of any one flow belong to a capability report, not here.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 4. Roles, permissions and organization

Under lead-ins: **the roles the system defines**; **what each is mainly responsible
for**; **the permission matrix** (role × capability × operation); **what data each
can see**; **how the organisational units relate**.

**The matrix carries confirmed findings only**, in exactly these three values:

| Value | Meaning |
| -- | -- |
| Confirmed allowed | The reviewed source explicitly permits the operation |
| Confirmed restricted | The reviewed source explicitly rejects or narrows it |
| Not determined | This analysis cannot establish the result |

**MUST NOT** infer permission from the existence of a page or an entry point, and
**MUST NOT** infer denial from the absence of a confirmed permission. Much
authorization is decided inside the code that handles a request rather than declared
where the request arrives; the report **MUST** say so under its own lead-in, because
a reader otherwise takes a blank cell for an absence of control.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 5. Data landscape and movement

Under lead-ins: **what the core data is**; **who creates and changes it** — which
user actions or automated processes do so; **which parts were observed reading and
writing it**; **how it moves between parts** (diagram); **what comes from outside**;
**what is sensitive**; **whether it can be exported, deleted or archived**;
**whether anything partitions it by organisation**.

**MUST NOT** infer ownership — business, team, or authoritative-copy — from read and
write activity. Writing something most often is not owning it. Ownership is
`unavailable` unless the source or its documentation declares it.

Where the direction of some accesses could not be determined, the report **MUST**
state that the observed-access table is a lower bound, with the undetermined count
and its denominator.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 6. External dependencies and integrations

| Service | What it is used for | Which capabilities depend on it | Sent and received | On failure |
| -- | -- | -- | -- | -- |

Then, under lead-ins: **what is sent and received**, and whether it includes personal
or financial fields; **what the code does when a call fails**; **the expected effect
of a failure**, as far as the call path supports — the user's action may fail; the
action may succeed while its notification is delayed or lost; background data may go
stale; an optional step may be unavailable.

Use "may", "is likely to" or "the reviewed path suggests" for an inferred effect.
Write "stops working" only where the source shows a hard synchronous dependency —
and remember that a retry may live in a client library, a gateway or the
infrastructure, none of which this analysis sees.

Purpose **MUST** come from the call site's context. Where it cannot be read, mark it
undetermined; **MUST NOT** speculate. Where the address is assembled at runtime, say
the integration exists and its address is `unavailable`. Cost, quota, compliance
conclusions and alternatives are `unavailable` — chapter 10.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 7. Operations and back-office capabilities

Under lead-ins: **which management capabilities exist and who uses them**; **which
write production data directly**; **which leave an audit record**; **limits declared
in code**; **what runs on a schedule**.

Hard limits — export caps, batch sizes, file-size limits, thresholds — have direct
operational value and **MUST** be listed with their locations. Runtime performance is
`unavailable`.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 8. Risks and current state

Grouping, format and priority: `writing-rules.md`. The analyser's own coverage gaps
belong in chapter 10, never here.

Five numbered sub-sections, each marked with the evidence it rests on:

* **8.1 Architectural risks** `fact` + `inferred` — findings that resolve to an exact
  location, and contradictions between parts
* **8.2 Expected rules not found in the reviewed paths** `verified` — every checklist
  item that ended `searched, not found`, with the rows searched. Each entry is a gap
  in coverage or a question to settle, **MUST NOT** be written as an established
  defect: the rule may sit in a database constraint, a gateway, a framework default,
  a dependency, or a path this analysis could not follow
* **8.3 No caller found within the analysed scope** `fact` — the scope searched
  **MUST** be stated, and the report **MUST** say that this does not establish the
  capability is unused: an external client, another system, a manual tool or an older
  client may call it. Entry points serving something outside the workspace **MUST**
  be separated out
* **8.4 Documentation contradicting code** `fact`
* **8.5 Still to confirm** `unavailable`

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 9. Glossary

Three columns, per `writing-rules.md`. Covers the project's internal business terms,
abbreviations, status values and role codes.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 10. Coverage and source snapshot

Under lead-ins: **the snapshot analysed** — each root's revision and whether it
carried uncommitted changes; **what was read** — files analysed and not analysed,
with reasons; **what the analyser cannot see** — its own limits, each figure with its
denominator; **how well evidenced each chapter is**.

Then **the exclusion table**: every question this report does not answer, with the
data source to consult instead. Actual usage per capability, production configuration
and switch states, external service cost and quota, data retention and compliance,
recent incidents, ownership, the project's stage and business goals — plus anything
the checklist ended as `cannot be determined here`. Each gets a reason.

---

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## Appendix: acceptance criteria (pipeline gate; not part of the report)

* Chapter 1 survives its own test: with every marker and citation deleted, it still
  tells a business owner what the project is.
* Chapter 3's map names capabilities, not directory or repository names.
* Every chapter has bolded lead-ins for its sub-questions, and closes with its
  synthesis.
* Every checklist item appears with a verdict, and every non-empty verdict cites ids
  that exist in the base.
* At least one finding came from `open` and is not a pre-computed
  `structural-finding` row.
* Every coverage figure carries its denominator.
* Every `unavailable` and `cannot-determine` item is named in chapter 10 with a
  reason.
