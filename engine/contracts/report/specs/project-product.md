---
id: project-product
scope: project
audience: product
version: 3.0.0
title: Project overview, non-technical
---

# Project overview, non-technical

> Audience: product managers, business owners, operations leads, project managers.
> Goal: without reading code, be able to say what this project is, what it can do,
> how those capabilities relate, and what is wrong with it.

How to write and how to investigate: `engine/contracts/report/writing-rules.md`.
This spec defines only the chapters and what belongs in each.

# Chapters

Eleven, in this order, numbered. No tier headings above them — the numbering is the
only structure the reader needs.

Every chapter is built the same way: a short paragraph that answers the chapter's
question, then **bolded lead-ins** naming each sub-question below, then the chapter's
closing synthesis. The lead-ins are what let a reader skim to the one thing they came
for; a chapter of undifferentiated paragraphs makes them read all of it or none.

## 1. What this project is, and where its edges are

An **introduction**, not an answer sheet — the only chapter written as though the
reader has asked "what is this?" and nothing else.

**The test this chapter MUST pass:** delete every marker, parenthetical and citation.
What is left has to be something you could read aloud to a business owner who has
never heard of the project, and they would come away knowing what it does. If
deleting the evidence leaves a chapter that says nothing, it was answered, not
written.

Open with a paragraph naming **what kind of organisation runs this, what business it
is in, and what the system connects to what**. "An HR platform" is a label, not a
sentence: it fits a hundred systems. What makes a system legible is its shape — that
work hours become both a client's invoice and an employee's performance record. Name
the shape, and name the company or the kind of company if the evidence supports it.

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
many areas of the business. Counts of code artifacts belong in chapter 11 if
anywhere.

## 2. Systems and repositories

| System | What it is for | Who uses it | What it carries | Notes |
| -- | -- | -- | -- | -- |

Then: **is any of them historical or being retired** — answered as `verified`, by
searching rather than by assuming from a name. A part named like an old version is a
hypothesis, not a finding: check whether anything still calls it, whether it still
writes data, and whether scheduled work still runs in it.

File counts, language breakdowns and line counts **MUST NOT** appear. Deployment and
runtime environment are `unavailable`.

## 3. Business domains and capability map

```text
project
└── business domain
    └── capability
        └── what a user can do
```

Named in business terms. A directory name, route prefix or repository name appearing
as a capability is a defect — resolve it to what a user can do, or leave it out.

**Capability sources** **MUST** cover: end-user pages, admin console, mobile, API
surface, import/export, notifications, third-party integrations, scheduled jobs.

**Capability status** — only four values, because only these are decidable from
source:

| Status | Basis |
| -- | -- |
| Behind a switch | Wrapped in a configuration-driven condition |
| Unfinished | An unimplemented branch or an explicit note saying so |
| Deprecated | An explicit deprecation marker |
| Unconfirmed | None of the above holds |

"In normal use", "partially used" and "used by specific customers" need runtime and
commercial information; they belong in chapter 11 and **MUST NOT** be status values.

**How the parts relate** — its own sub-section, with a diagram, under these lead-ins:
which call each other and which span more than one repository; which share a business
object and which is read or written by more than one part; which one the most others
depend on. Internal steps of any one flow belong to a capability report, not here.

## 4. Roles, permissions and organization

Under lead-ins: **the roles the system defines**; **what each is mainly responsible
for**; **the permission matrix** (role × capability × operation); **what data each
can see**; **how the organisational units relate**.

Where authorization is largely decided inside handler bodies rather than declared at
the entry point, the report **MUST** say so under its own lead-in — otherwise a
reader takes an absence in the matrix for an absence of control.

## 5. Core business objects and lifecycles

Under lead-ins: **the core objects**; **how they relate** (diagram); **a worked
lifecycle** for the objects that have one (diagram, labelled in the target language);
**which involve money, permissions or sensitive information**.

Business names in the body; raw table names **MUST NOT** appear there. Read/write
counts **MUST NOT** be an object's primary description. For sensitive fields, state
the basis for the determination only; **MUST NOT** rate how sensitive they are.

## 6. Data landscape and movement

Under lead-ins: **what the core data is**; **who creates it and which part owns it**;
**how it moves between parts** (diagram); **what comes from outside**; **what is
sensitive**; **whether it can be exported, deleted or archived**; **whether anything
partitions it by organisation**.

Where the direction of some accesses could not be determined, the report **MUST**
state that the ownership table is a lower bound, with the undetermined count and its
denominator.

## 7. External dependencies and integrations

| Service | What it is used for | Which capabilities depend on it | Sent and received | On failure |
| -- | -- | -- | -- | -- |

Then, under lead-ins: **what is sent and received**, and whether it includes personal
or financial fields; **what the code does when a call fails**; **which capabilities
stop working** if a given dependency is down — the last one as `inferred`, from which
capabilities the call sites sit in.

Purpose **MUST** come from the call site's context. Where it cannot be read, mark it
undetermined; **MUST NOT** speculate. Where the address is assembled at runtime, say
the integration exists and its address is `unavailable`. Cost, quota, compliance
conclusions and alternatives are `unavailable` — chapter 11.

## 8. Operations and back-office capabilities

Under lead-ins: **which management capabilities exist and who uses them**; **which
write production data directly**; **which leave an audit record**; **limits declared
in code**; **what runs on a schedule**.

Hard limits — export caps, batch sizes, file-size limits, thresholds — have direct
operational value and **MUST** be listed with their locations. Runtime performance is
`unavailable`.

## 9. Risks and current state

Every entry rests on the project contradicting itself or lacking something.
**MUST NOT** cite external best practice. The analyser's own coverage gaps belong in
chapter 11, never here. Format and priority: `writing-rules.md`.

Five numbered sub-sections, each marked with the evidence it rests on:

* **9.1 Architectural risks** `fact` + `inferred` — findings that resolve to an exact
  location, and contradictions between parts
* **9.2 Business rules that appear to be missing** `verified` — every checklist item
  that ended `searched, not found`, with the rows searched
* **9.3 Code nothing reaches** `fact` — the search scope for callers **MUST** be
  stated; endpoints serving something outside the workspace **MUST** be separated out
* **9.4 Documentation contradicting code** `fact`
* **9.5 Still to confirm** `unavailable`

## 10. Glossary

Three columns, per `writing-rules.md`. Covers the project's internal business terms,
abbreviations, status values and role codes.

## 11. Coverage and source snapshot

Under lead-ins: **the snapshot analysed** — each root's revision and whether it
carried uncommitted changes; **what was read** — files analysed and not analysed,
with reasons; **what the analyser cannot see** — its own limits, each figure with its
denominator; **how well evidenced each chapter is**.

Then **the exclusion table**: every question this report does not answer, with the
data source to consult instead. Actual usage per capability, production configuration
and switch states, external service cost and quota, data retention and compliance,
recent incidents, ownership, the project's stage and business goals — plus anything
the checklist ended as `cannot be determined here`. Each gets a reason.

This chapter describes **the boundary of the analysis**, not a problem with the
project. The two **MUST NOT** be mixed.

---

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
* Every `unavailable` and `cannot-determine` item is named in chapter 11 with a
  reason.
