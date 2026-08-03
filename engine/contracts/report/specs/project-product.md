---
id: project-product
scope: project
audience: product
inherits: contract.md
version: 1.0.0
title: Project overview, non-technical
requires:
  - auth-annotation
  - component
  - coverage-note
  - cross-root-link
  - data-access
  - discarded-error
  - entity
  - entity-field
  - entity-relation
  - feature
  - guard
  - health-signal
  - map-edge
  - module
  - module-containment
  - notification-call
  - outbound-call
  - route
  - run-context
  - scheduled-task
  - source-file
  - state
  - structural-finding
  - transaction-boundary
  - transition
  - value-set
---

# Project overview, non-technical

> Audience: product managers, business owners, operations leads, project managers.
> Goal: without reading code, be able to say what the project is made of, what it can do, and how those capabilities relate.

Writing rules are inherited from `contract.md`. This spec defines only what to write.

The overview answers **structural** questions: what the project is made of, what capabilities exist, and how they relate. The steps, branches and failure handling of any single business flow belong to `module-product`.

## Reading layers

| Layer | Chapters | Use |
| -- | -- | -- |
| **Essential** | 1–3 | Three screens that establish the whole picture |
| **On demand** | 4–8 | Look up a specific question; skimmable |
| **Specialist** | 9–12 | Troubleshooting, limits of knowledge, glossary, analysis boundary |

---

# Essential

## 1. Project scope and boundary

| Question | Marker |
| -- | -- |
| The project's stated purpose | `unavailable` — see below |
| Which user roles the system defines | `fact` |
| Which capabilities are inside the project | `fact` |
| Which capabilities are provided by external systems | `fact` |
| Project stage (pilot, mature, maintenance) | `unavailable` |

**Requirement**: the first paragraph answers "what is this project made of, and which roles are involved". It **MUST NOT** open with a description of the analysis method.

**Known gap on stated purpose**: the knowledge base records which files are documentation (via `source-file` classification) but **does not extract document bodies**, so a README's self-description is not in the fact pack. `run-context.description` carries a single text fragment; on the reference target its content came from the front-end repository's scaffolding boilerplate, not from a project self-description.

This row is therefore `unavailable`. The report **MUST NOT** infer the project's purpose from module names, table names or domains, and **MUST NOT** quote README text that is not in the fact pack. What can be stated as fact is which source roots contain a README and which do not — that comes straight from file classification.

Extracting document bodies is an analysis-layer change and is out of scope for this work.

## 2. Systems and repositories

| System or repository | Business modules carried | Intended users | Has live entry points | Called by which repositories |
| -- | -- | -- | -- | -- |

| Question | Marker |
| -- | -- |
| Which independently deployable parts the project has | `fact` |
| Which business modules each part carries | `fact` |
| Which kind of user it serves (employee-facing, admin console, mobile, backend service) | `fact`, from entry-point type and host repository |
| Whether it has live entry points and is called by other repositories | `fact` |
| Whether any repository or large block of code has no reachable entry point | `fact` |
| Deployment and runtime environment | `unavailable` |

**Requirement**: file counts, language breakdowns and line counts **MUST NOT** appear — they mean nothing to a business reader. A repository's purpose is expressed as "which modules it carries"; a summarizing characterization **MUST NOT** be written.

## 3. Business domains and capability map

```text
project
└── business domain
    └── functional module
        └── capability
```

Capability sources **MUST** cover: end-user pages, admin console, mobile, API surface, import/export, notifications, third-party integrations, scheduled jobs.

### Capability status

Status **MUST** be decidable from source:

| Status | Basis | Marker |
| -- | -- | -- |
| Reachable entry point | A route or UI entry exists and the call chain is reachable | `fact` |
| Code with no entry point | Reachability analysis finds no entry | `fact` |
| Explicitly deprecated or unfinished | deprecated marker, unimplemented branch, TODO | `fact` |
| Behind a switch | Wrapped in a feature-flag condition | `fact` |
| Unconfirmed | None of the above holds | — |

"In normal use", "partially used", "used by specific customers" need runtime and commercial information. They are `unavailable` and **MUST NOT** be status values.

**Output**: the capability map (domain → module → capability, with status).

### How modules relate

Module reports see one module at a time and cannot see how modules cooperate. This section is the overview's alone.

| Question | Marker |
| -- | -- |
| Which modules call each other | `fact` |
| Which modules share a business object | `fact` |
| Which module the most other modules depend on | `fact` |
| Which modules span more than one repository | `fact` |
| Which modules read and write a given core business object | `fact` |

**Output**: the module relationship diagram.

**Requirement**: show only calls and shared data between modules. The internal steps, branches or failure handling of any flow **MUST NOT** be expanded here.

---

# On demand

## 4. Roles, permissions and organization

| Question | Marker |
| -- | -- |
| Which user roles the system defines | `fact` |
| Which entry points each role can reach | `fact` |
| Which operations each role can perform | `fact` |
| Data visibility scope (own, department, company-wide) | `fact`, from query filters |
| Whether any role or path bypasses those limits | `fact` |
| How company, tenant, organization and department relate | `fact` |

**Output**: a permission matrix (role × module × operation) and an organization diagram.

**Requirement**: a role's responsibilities are expressed as "which entry points it reaches and which operations it performs"; a summarizing characterization **MUST NOT** be written. Where authorization is largely decided inside handler bodies rather than declared on routes, the report **MUST** say which layer the matrix covers and which it does not.

## 5. Core business objects and lifecycles

| Question | Marker |
| -- | -- |
| Which core business objects exist | `fact` |
| Which UI strings and enums each object appears in | `fact` |
| How objects relate | `fact` |
| Each object's state set and transitions | `fact` |
| Who creates and who changes it | `fact` |
| Fields matching a sensitive-term list, passing through encryption, or guarded by a permission check | `fact` |

**Output**: a core-object relationship diagram and state-transition diagrams for the main objects.

**Requirement**: use business names, **MUST NOT** use database table names. Read/write counts **MUST NOT** be an object's primary description. Table structure **MUST NOT** be required. For sensitive fields, state the basis for the determination only; **MUST NOT** rate how sensitive they are.

## 6. Data landscape and movement

| Question | Marker |
| -- | -- |
| What the core data is | `fact` |
| Which system writes each kind | `fact` |
| Which systems read each kind | `fact` |
| Which data has more than one writer | `fact` |
| How data moves between systems | `fact` |
| Which data comes from external systems | `fact` |
| Whether it can be exported, deleted, archived | `fact`, from whether the entry point exists |
| Whether queries carry a tenant or organization filter | `fact` |
| Data retention period | `unavailable`, unless a cleanup job is declared in code |

**Output**: a data-flow diagram. Table structure **MUST NOT** be required.

**Requirement**: where the direction of some data accesses could not be determined, the report **MUST** state that the ownership table is a lower bound rather than a complete set, and give the undetermined count with its denominator.

## 7. External dependencies and integrations

Grouped by purpose: sign-in, payment, messaging (SMS/email/push), maps, file storage, third-party data, webhooks, open APIs.

| External service | Purpose | Which modules depend on it | What is sent and received | Failure handling |
| -- | -- | -- | -- | -- |

| Question | Marker |
| -- | -- |
| Which external services are integrated | `fact` |
| The purpose of each | `fact`, from the call site's context; mark "undetermined" when it cannot be read |
| Which modules depend on it | `fact` |
| What is sent to it and received from it | `fact` |
| Whether the transferred data includes personal or financial fields | `fact` |
| How the code handles a failed call (retry, degrade, error, silently ignore) | `fact` |
| Cost, quota, compliance conclusions, alternatives | `unavailable` |

**Requirement**: purpose **MUST** come from the call site's context, e.g. "called inside the attachment-upload handler". Where it cannot be read, mark "undetermined"; **MUST NOT** speculate. Anything marked "silently ignored" **MUST** name the exact location. Where the target address is assembled at runtime, the report **MUST** state that the integration exists while its address is `unavailable`.

## 8. Operations and back-office capabilities

Covers: user management, permission management, content and configuration, review queues, support and ticketing, finance and reconciliation, bulk operations, import/export, manual correction and data repair, reporting and log search.

| Question | Marker |
| -- | -- |
| Which management capabilities the back office provides | `fact` |
| Which roles use each | `fact` |
| Which operations write production data directly | `fact` |
| Which operations leave an audit record | `fact` |
| Limits declared in code (page size, batch size, file size, timeout) | `fact` |
| Which capabilities run automatically on a schedule | `fact` |

**Requirement**: hard limits such as "export caps at 1000 rows" have direct operational value and **MUST** be listed with their locations. Runtime performance (whether it is slow, real data volumes, bottlenecks) is `unavailable` and **MUST NOT** be a question here.

---

# Specialist

## 9. Problems and risks

Grouping and prohibitions: `contract.md` section 5.

### 9.1 Problems that resolve to an exact location `fact`

* The same permission check written inconsistently across its uses
* Keys, credentials and external addresses hardcoded in source
* Errors that are caught and then neither logged nor reported
* External calls made inside a transaction
* External calls with no declared timeout

### 9.2 Contradictions between systems `fact`

* More than one system writing the same kind of data
* One side reading what another writes, with no interface between them
* The same kind of data declared with different structures in different systems
* The same entry path declared by more than one system
* One business with both an old and a new entry point whose validation or error responses differ
* Circular dependencies between systems

### 9.3 Code with no reachable entry point `fact`

Fully implemented capabilities for which reachability analysis finds no entry. This is what static analysis alone can find — neither interviews nor runtime monitoring see it.

**Requirement**: the search scope for callers **MUST** be stated. When callers are sought only inside this workspace, standard protocol endpoints are miscounted; they **MUST** be separated out and explained.

### 9.4 Documentation contradicting code `fact`

Determinations **MUST** stay within what the fact pack supports: which source roots have a README and which do not, and whether an explicit deprecation notice matches its actual reference count. Document bodies are not in the fact pack (see chapter 1), so "the README claims X while the code does Y" is `unavailable`.

### 9.5 Absences established by search `verified`

The loop: `contract.md` section 6.

## 10. Unsafe assumptions

Requirements: `contract.md` section 9. Examples:

* The report lists a module — that does not mean the business still uses it. The report can only show the code exists and has an entry point.
* The report did not find a rule — that does not mean the limit is absent in production. It may live in the UI, in a database constraint, or in a manual process.
* A capability appears in one repository only — that does not mean that repository owns it. Other repositories may read and write the data directly.
* No entry point is visible in the UI — that does not mean the endpoint cannot be called.
* The report does not list a problem — that does not mean it does not exist, only that static source review found no evidence of it.

## 11. Glossary `fact`

Format and requirements: `contract.md` section 7. Covers the project's internal business terms, abbreviations, status values and role codes.

## 12. Coverage and analysis boundary

Requirements: `contract.md` section 8.

### 12.1 What was read `fact`

| Item | Content |
| -- | -- |
| Source snapshot | Each repository's revision, whether it had uncommitted changes, analysis time |
| Read scope | Files read, files not read and why |
| Resolution depth | Share of entry points traceable, share of call chains terminating early, share of unresolved external calls |
| Evidence sufficiency per chapter | Evidenced / checked-and-not-found / not executed / not determinable from static source |

### 12.2 Questions this report does not answer

| Question | Data source to consult |
| -- | -- |
| Actual usage and volume per capability | Analytics and business data |
| Configuration and switch states actually in effect in production | Configuration service |
| External service costs, quotas and contract terms | Procurement and finance |
| Data retention and compliance requirements | Legal and compliance |
| Recent production incidents and operational feedback | Incident records and support system |
| Ownership of each module | Team records |
| The project's business goals and current stage | Product documentation and the business owner |

---

## Appendix: acceptance criteria (pipeline gate; not part of the report)

The report should be able to answer:

* Which systems the project comprises and which business modules each carries
* Which business capabilities exist, which have reachable entry points and which have code with none
* How those capabilities relate and which data they share
* Which entry points, operations and data scope each role has
* How the core objects relate, who writes the data and who reads it
* Which external services are integrated, their purpose and their failure handling
* Which locatable problems and cross-system contradictions exist, and the basis for each
* Which conclusions are evidenced and which are genuinely unavailable
* Which conclusions the reader should not draw
* Which questions this report does not answer and where to look instead
