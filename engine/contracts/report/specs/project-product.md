---
id: project-product
scope: project
audience: product
version: 2.0.0
title: Project overview, non-technical
---

# Project overview, non-technical

> Audience: product managers, business owners, operations leads, project managers.
> Goal: without reading code, be able to say what this project is, what it can do,
> how those capabilities relate, and what is wrong with it.

How to write and how to investigate: `engine/contracts/report/writing-rules.md`.
This spec defines only the chapters and what belongs in each.

# Chapters

| Layer | Chapters | Use |
| -- | -- | -- |
| **Essential** | 1–3 | Three screens that establish the whole picture |
| **On demand** | 4–9 | Look up one question; skimmable |
| **Specialist** | 10–13 | Risks, limits of knowledge, glossary, analysis boundary |

## Essential

### 1. What this project is

The one sentence, then a short paragraph or two: what it is for, who it serves, and
one honest number about its size. Then the shape — how many parts, of what kinds —
named in a sentence, leaving the inventory to chapter 2.

| Question | Marker |
| -- | -- |
| What the project is and what it is for | `inferred`, from the facts named |
| What the project says about itself | `fact` from `readme-section` / `project-title`, or `unavailable` if it carries none |
| Which user roles it defines | `fact` |
| Which capabilities are inside the project, and which come from outside | `fact` |
| Project stage — pilot, mature, maintenance | `unavailable` |

### 2. Systems and repositories

| Part | What it carries | Who uses it | Live entry points | Called by |
| -- | -- | -- | -- | -- |

Each part gets one line saying what it is for, in business terms — `inferred`, from
the capabilities it carries. File counts, language breakdowns and line counts
**MUST NOT** appear; they mean nothing to this reader. Deployment and runtime
environment are `unavailable`.

### 3. Business domains and capability map

```text
project
└── business domain
    └── capability
        └── what a user can do
```

Named in business terms. A directory name, route prefix or repository name appearing
as a capability is a defect — resolve it to what a user can do, or leave it out.
Capability sources **MUST** cover: end-user pages, admin console, mobile, API
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
commercial information. They go in chapter 13 and **MUST NOT** be status values.

Then: how the capabilities relate — which call each other, which share a stored
object, which one the most others depend on, which span more than one part. Output a
relationship diagram. Internal steps of any one flow belong in chapter 6.

## On demand

### 4. Roles, permissions and organization

Which roles exist, which entry points each reaches, which operations each performs,
what data each can see, whether any path bypasses those limits, and how the
organizational units relate. Output a permission matrix and an organization diagram.

Where authorization is largely decided inside handler bodies rather than declared at
the entry point, the report **MUST** say which layer the matrix covers and which it
does not — otherwise the reader takes an absence in the matrix for an absence of
control.

### 5. Core business objects and lifecycles

Which objects exist, how they relate, each one's states and transitions, who creates
and who changes it, and which fields match a sensitive-term list. Output an object
relationship diagram and state diagrams for the main objects.

Use business names; **MUST NOT** use raw table names in the body. Read/write counts
**MUST NOT** be an object's primary description. For sensitive fields, state the
basis for the determination only; **MUST NOT** rate how sensitive they are.

### 6. Core business flows

The five to ten end-to-end flows that matter most. Each: the roles involved, the
parts it crosses, the main steps, what is automatic and what is manual, what it
depends on outside the system, and what the code does when a step fails.

### 7. Data landscape

What the core data is, who writes each kind, who reads it, which has more than one
writer, how it moves between parts, which comes from outside, whether it can be
exported, deleted or archived, and whether queries carry an organization filter.
Output a data-flow diagram. Table structure **MUST NOT** be required.

Where the direction of some accesses could not be determined, the report **MUST**
state that the ownership table is a lower bound, with the undetermined count and its
denominator.

### 8. External dependencies

| Service | Purpose | Which capabilities depend on it | What is sent and received | Failure handling |
| -- | -- | -- | -- | -- |

Purpose **MUST** come from the call site's context. Where it cannot be read, mark it
undetermined; **MUST NOT** speculate. Where the address is assembled at runtime, say
the integration exists and its address is `unavailable`. Cost, quota, compliance
conclusions and alternatives are `unavailable` — chapter 13.

### 9. Operations and back-office capabilities

Which management capabilities exist, who uses each, which write production data
directly, which leave an audit record, and which run on a schedule. Limits declared
in code — export caps, batch sizes, file-size limits — have direct operational value
and **MUST** be listed with their locations.

## Specialist

### 10. Risks and current state

Every entry rests on the project contradicting itself or lacking something.
**MUST NOT** cite external best practice. The analyser's own coverage gaps belong in
chapter 13, not here. Format and priority rules: `writing-rules.md`.

Group by how each finding was determined:

* **10.1** Findings that resolve to an exact location
* **10.2** Contradictions between parts
* **10.3** Code with no reachable entry point — the search scope for callers **MUST**
  be stated; when callers were sought only inside this workspace, endpoints serving
  something outside it are miscounted and **MUST** be separated out
* **10.4** Documentation contradicting code
* **10.5** Absences established by search — the three-verdict loop, every checklist
  item that ended in `searched, not found`

### 11. Unsafe assumptions

The wrong conclusions a reader is most likely to draw from **this** report. Each
entry is "fact X does not mean conclusion Y", with the reason, and **MUST**
correspond to a statement that actually appears here. Generic disclaimers **MUST NOT**
be written.

### 12. Glossary

Three columns, per `writing-rules.md`. Covers the project's internal business terms,
abbreviations, status values and role codes.

### 13. Coverage and what this report does not answer

* **What was read**: each root's revision and whether it carried uncommitted changes,
  from `source_roots`; files analysed and not analysed with reasons, from `files`;
  resolution depth, each figure with its denominator.
* **The exclusion table**: every question this report does not answer, with the data
  source to consult instead. Actual usage per capability, production configuration
  and switch states, external service cost and quota, data retention and compliance,
  recent incidents, module ownership, the project's stage and business goals — plus
  anything the checklist ended as `cannot be determined here`. Each gets a reason.

This chapter describes **the boundary of the analysis**, not a problem with the
project. The two **MUST NOT** be mixed.

## Appendix: acceptance criteria (pipeline gate; not part of the report)

* Chapter 1 says in one sentence what this project is.
* Chapter 3's map names capabilities, not directory or repository names.
* Every checklist item appears with a verdict, and every non-empty verdict cites ids
  that exist in the base.
* At least one finding came from `open` and is not a pre-computed
  `structural-finding` row.
* Every coverage figure carries its denominator.
* Every `unavailable` and `cannot-determine` item is named in chapter 13 with a
  reason.
