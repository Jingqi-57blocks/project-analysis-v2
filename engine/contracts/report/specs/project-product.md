---
id: project-product
scope: project
audience: product
version: 7.0.0
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
below for that reason: as a general instruction it was applied inconsistently from
one run to the next, and in one run not at all. It is the difference between a
document that argues something and one that answers questions.

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

Open with the most specific description the evidence supports: **what kind of
organisation appears to use this, which activities it puts in one place, and what
those activities share**. "An HR platform" is a label, not a sentence: it fits a
hundred systems. What makes a system legible is which activities sit together and
what they have in common.

Where the organisation or its business cannot be established from the base, describe
what the system is for without guessing it. Module and table names are not evidence
of an industry.

Describe the relationships the system supports; **MUST NOT** turn a data relationship
into a mandatory causal chain. Where one record is used by several processes,
describe those uses as separate supported relationships — this one *may contribute
to* that calculation, that process *may reference* this record. That any record is
universally transformed into some other outcome is a claim the base would have to
prove exhaustively, and it will not.

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
* **Project stage** — `unavailable`, unless supplied project or business
  documentation states it outright, in which case quote it. Repository age, version
  numbers in names, and two implementations existing side by side are **not**
  evidence of a stage. One line either way.

Numbers here **MUST** be ones a business reader can use: how many kinds of user, how
many areas of the business. Counts of code artifacts belong in chapter 10 if
anywhere.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 2. The parts, and what each is responsible for

A **part** is an application people use, an independently operated service, or an
independently operated background component with a business responsibility of its
own. A repository is *evidence* for finding parts, never automatically a part: one
part may span several repositories, and one repository may hold more than one. A
report whose parts map one-to-one onto repositories has listed the repositories.

| Part | What it is for | Who uses it | Business capabilities and records it handles | Notes |
| -- | -- | -- | -- | -- |

Then two questions that are often run together and **MUST NOT** be:

* **Does it still take part in this snapshot** — `verified`, by searching rather than
  assuming from a name. A part named like an old version is a hypothesis: check
  whether anything still calls it, whether it still changes data, and whether
  scheduled work is still registered in it.
* **Does the organisation intend to retire it** — `unavailable`, unless the source or
  its documentation says so outright. Two implementations of one thing existing side
  by side does not establish that a migration is under way, still less that anyone
  plans to finish it.

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
which call each other and which span more than one part; which share a business
object, and which objects more than one part reads or writes.

**Which parts the most others reach** is three different questions, and they **MUST
NOT** be merged into one ranking without naming which was counted: direct calls;
shared reads and writes; shared business objects. "The employee record is read by
four parts" and "the employee module is a single point of dependency" are different
statements, and only the first is evidenced.

Internal steps of any one flow belong to a capability report, not here.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 4. Roles, permissions and organization

Under lead-ins: **the roles the system defines**; **what each is mainly responsible
for**; **the permission matrix** (role × capability × operation); **what data each
can see**; **how the organisational units relate**.

The matrix's rows are the capability groups named in chapter 3, and its columns a
fixed business-level set: view, create, change, approve, export, administer. Fixing
both is what lets two runs over one snapshot be compared at all.

**Every cell carries exactly one of these four values, and none is left blank:**

| Value | Meaning |
| -- | -- |
| Confirmed allowed | The reviewed source explicitly permits the operation |
| Confirmed restricted | The reviewed source explicitly rejects or narrows it |
| Not determined | This analysis cannot establish the result |
| Not applicable | The operation does not exist for this capability |

Only the first two are findings. "Not determined" records a limit of the analysis,
and is the honest value for most cells in most projects. "Not applicable" is a
property of the capability — a read-only capability has nothing to approve — and is
neither a finding nor a limit; writing it as "not determined" would report the
analysis as weaker than it is. A blank cell is read as "no permission needed", which
is a claim nobody made.

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
writing it**; **how it is shared, handed over or synchronised between parts**
(diagram) — parts that read the same stored record are sharing it, not moving it, and
a diagram of arrows between parts describes the wrong system; **what comes from
outside**;
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
actions change live business records**; **which leave an audit trail**; **business
limits the system enforces**; **what the code schedules to happen automatically** —
phrased as what is arranged, not as what happens: a registered schedule is a
declaration in the reviewed snapshot, and whether it is enabled, fires, or finishes
is not visible here.

"Production data" is not a thing the base can identify — it sees business records and
cannot tell which deployment they belong to. Say business records.

Hard limits — export caps, batch sizes, file-size limits, thresholds — carry direct
operational value and **MUST** be given: the limit, and what it does to someone who
hits it. Where they are declared belongs in the collapsed evidence. Runtime
performance is `unavailable`.

**What this means** — the synthesis: two or three sentences on what this chapter's
facts mean for reading the rest of the report. It is a fixed lead-in like an evidence
marker, rendered per `writing-rules.md`; every chapter carries it.

## 8. Risks and current state

Grouping, format and priority: `writing-rules.md`. The analyser's own coverage gaps
belong in chapter 10, never here.

Five numbered sub-sections, each marked with the evidence it rests on:

* **8.1 Architectural risks** `fact` + `inferred` — findings that resolve to an exact
  location, and contradictions between parts. A difference between parts is a
  contradiction only where they implement the same rule, act on the same shared
  record, or are expected to hold to the same contract. Two parts doing different
  things differently is not a finding
* **8.2 Expected rules not found in the reviewed paths** `verified` — the **material**
  questions that `searched, not found` verdicts raise, with the scope searched. Every
  item has its verdict in `checklist.json`; the report does not reproduce the file.
  Each entry is a gap in coverage or a question to settle, **MUST NOT** be written as
  an established defect: the rule may sit in a database constraint, a gateway, a
  framework default, a dependency, or a path this analysis could not follow
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
abbreviations, status values and role names.

An internal code — a numeric role id, an enum spelling — earns a row only where
people actually use it: where an administrator types it, a screen shows it, or the
supplied documentation refers to it. Otherwise it stays in the evidence.

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
recent incidents, ownership, the project's stage and business goals — plus the
material unanswered questions the `cannot be determined` verdicts represent. Entries
sharing one missing source and one reason are grouped into a single row; the
per-item record lives in `checklist.json`. Each gets a reason.

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
* Every checklist item carries exactly one verdict **in `checklist.json`**, with the
  fields its verdict requires, and every id it cites exists in the base.
* At least one entry records `origin: open-kb` — a finding reached by opening
  knowledge-base content no checklist hypothesis pointed at — and it is not a
  pre-computed `structural-finding` row.
* At least one material entry records `validatedBy`, resolving to `source-excerpt`
  rows in the base. (Those are knowledge-base content; the report stage still
  **MUST NOT** open the analysed project's files.)
* Every `cannot-determine` verdict carries an `exclusionGroup`, and every group
  referenced appears once in chapter 10 with its reason and what would settle it.
  Individual verdicts are **not** repeated in the report.
* Every coverage figure carries its denominator.
