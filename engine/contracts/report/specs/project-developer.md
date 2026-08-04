---
id: project-developer
scope: project
audience: developer
inherits: contract.md
version: 1.0.0
title: Project overview, technical
requires:
  - auth-annotation
  - call-edge
  - component
  - coverage-note
  - cross-root-link
  - data-access
  - discarded-error
  - entity
  - entity-constraint
  - entity-field
  - entity-relation
  - feature
  - feature-flow
  - guard
  - health-signal
  - import
  - map-edge
  - module
  - module-containment
  - notification-call
  - outbound-call
  - package-dependency
  - route
  - run-context
  - scheduled-task
  - source-file
  - structural-finding
  - symbol
  - test-relation
  - trace
  - transaction-boundary
  - unlinked-call
  - value-set
---

# Project overview, technical

> Audience: engineering leads, architects, senior developers.
> Goal: without starting the system, be able to explain what the project is built from, how a request is handled, who owns which data, which external services it depends on, and what a change would reach.

Writing rules are inherited from `contract.md`. This spec defines only what to write.

Chapters are ordered by when the questions arise while picking up an unfamiliar project, not by category of information.

The technical report **includes** the business description; it is not a parallel view alongside the non-technical one. A developer also has to understand what the product does before they can judge what a change means. The difference is that business content is **context** here — compressed to what establishes understanding — while the technical content is the substance.

## Reading layers

| Layer | Chapters | Use |
| -- | -- | -- |
| **Essential** | 0–3 | Project composition, business capabilities, how a request is handled |
| **On demand** | 4–6 | Look up a specific question |
| **Specialist** | 7–9 | Troubleshooting, how things are verified, analysis boundary |

---

# Essential

## 0. How to read this, and the glossary

### Reading paths

This chapter explains how to use the report; it contains no project facts.

* **First read**: chapters 0, 1, 2, 3 — project composition and request handling.
* **Taking on a specific change**: chapter 2 to locate the capability, chapter 6 for blast radius, chapter 7 for known problems in that area.
* **Investigating a production problem**: chapter 3 for the request path, chapter 5 for external dependencies, chapter 7 for known problems.

### Glossary `fact`

Format and requirements: `contract.md` section 7. Sourced from business object names, enum values and UI strings.

**Requirement**: the glossary **MUST** come first. The code and later chapters use the project's internal abbreviations heavily; without them, those chapters cannot be read.

## 1. Composition and technology stack

| Question | Marker |
| -- | -- |
| Which source roots exist, with file counts and size | `fact` |
| Language, framework and **declared version** per source root | `fact` |
| Direct and transitive dependencies | `fact` |
| Whether each source root has live entry points | `fact` |
| The direction of calls between source roots | `fact` |
| Whether any source root or large block of code has no reachable entry point | `fact` |
| How runtime versions are distributed across source roots | `fact` |
| Deployment units and orchestration | `unavailable`; where an orchestration file is in the repository, state what the file says and mark it as declared, not confirmed by running |
| Ownership | `unavailable` |

**Requirement**: runtime versions **MUST** be listed per source root — several technology generations coexisting is a structural fact that shapes all later work. Size is expressed as file and code counts and **MUST NOT** carry a quality judgement.

## 2. Business capability overview

This chapter supplies the business context the later technical chapters need. It **MUST NOT** expand flow detail; that belongs to `module-developer`.

| Question | Marker |
| -- | -- |
| Which business capabilities the project provides | `fact` |
| Which roles use each | `fact`, from permission checks declared on entry points |
| Which source roots each capability's code sits in | `fact` |
| Which external entry points each capability exposes | `fact` |
| The current status of each capability | `fact`, one of the four below |
| Which capabilities are implemented across more than one source root | `fact` |

| Status | Basis |
| -- | -- |
| Reachable entry point | An entry exists and the call chain is reachable |
| Code with no entry point | Reachability analysis finds no entry |
| Explicitly deprecated or unfinished | deprecated marker, unimplemented branch, TODO |
| Behind a switch | Wrapped in a feature-flag condition |

**Requirement**: capabilities are divided by code ownership and call relationships, **MUST NOT** by directory name. A capability **MAY** span source roots; a source root **MAY** carry several capabilities.

## 3. Request handling and call paths

| Question | Marker |
| -- | -- |
| Which kinds of external entry point exist (API, page route, message consumer, scheduled job, external callback) | `fact` |
| Where and how each kind is registered | `fact` |
| The middleware chain and its execution order | `fact` |
| Which layer performs authentication | `fact` |
| Which layers carry authorization decisions | `fact` |
| Startup order and configuration loading | `fact` |
| Graceful shutdown | `fact` |
| The boundary between synchronous and asynchronous paths | `fact` |
| How the front end is routed to several back ends | `fact` |
| Whether the same path is declared by more than one source root | `fact` |
| Whether an old and a new path coexist for the same business | `fact` |

### Complete call paths

At least four, from entry point through storage and side effects: a read path, a write path, a cross-root path, an asynchronous path.

```text
entry -> middleware (auth / authz / validation) -> handler
      -> business logic -> data access -> storage
      -> side effects (messaging / external call / notification) -> response
```

Each path states: the symbols and files traversed; where branches and early returns occur; at which step a cross-root call happens; side effects not evident from the function names.

**Requirement**:

* Where tracing stops, the report **MUST** mark the stopping point and the reason (dynamic construction, unresolved reference, cross-language boundary, reflection). It **MUST NOT** stitch a path that looks complete but is partly guessed.
* The middleware order **MUST** be given. That order decides the effective reach of authentication, authorization, logging and error handling.
* The basis for choosing these paths **MUST** be stated.

---

# On demand

## 4. Data architecture and ownership

| Question | Marker |
| -- | -- |
| Which data entities, fields and types exist | `fact` |
| Primary keys and unique constraints | `fact` |
| Relationships between entities | `fact` |
| Which source root writes each entity | `fact` |
| Which source roots read each entity | `fact` |
| Entities written by more than one source root | `fact` |
| Entities one side reads and another writes, with no interface between | `fact` |
| Whether an entity's structure is declared consistently across source roots | `fact` |
| Soft-delete and audit fields | `fact` |
| Fields matching a sensitive-term list, passing through encryption, or guarded by a permission check | `fact` |
| Indexes | `fact` where declared in code or migrations; otherwise `unavailable` |
| Sharding, read/write splitting, cache, search, warehouse | `unavailable`; where a client dependency exists in code, state only that the dependency exists |
| Physical topology, archival, retention, backup and restore | `unavailable` |

**Requirement**: multi-writer entities and inconsistent structure declarations **MUST** each be listed by entity name, the source roots involved, and the differing fields. For sensitive fields, state the basis only (name match, encryption call present, guarded by a permission check); **MUST NOT** rate how sensitive they are.

## 5. External service dependencies

The system's boundary with external services, symmetric to chapter 4's internal data boundary.

| External service | Purpose | Which capabilities call it | Sync / async | Failure handling in code | Credentials required |
| -- | -- | -- | -- | -- | -- |

| Question | Marker |
| -- | -- |
| Which external services are integrated | `fact` |
| Which capabilities and which code locations call each | `fact` |
| What is sent and received | `fact` |
| Purpose | `fact`, from the call site's context; "undetermined" where it cannot be read |
| Synchronous or asynchronous | `fact` |
| Declared timeouts and retry counts | `fact` where they are literals |
| Failure handling: error, retry, degrade, silently ignore | `fact` |
| Whether a degradation branch exists | `fact` |
| External credentials and configuration keys needed to run the system | `fact`, from keys declared in configuration samples |
| External calls whose target could not be resolved | `fact` |
| Cost, quota, compliance conclusions, alternatives | `unavailable` |

**Requirement**: purpose **MUST** come from the call site's context, e.g. "called inside the attachment-upload handler"; where it cannot be determined, mark "undetermined" and **MUST NOT** speculate. Failure handling **MUST** be given per item, and anything marked "silently ignored" **MUST** name the file and line. The credential list also answers what is needed to run locally and **MUST** be complete.

## 6. Dependencies and blast radius

| Question | Marker |
| -- | -- |
| Dependency direction between source roots | `fact` |
| Dependency direction between modules | `fact` |
| Whether circular dependencies exist between source roots | `fact` |
| Whether circular dependencies exist between modules | `fact` |
| The module the most other modules depend on | `fact` |
| The exact locations where cross-root calls happen | `fact` |
| Locations that read or write another party's data directly, bypassing its interface | `fact` |
| Modules implemented across several source roots | `fact` |
| Which source roots must be released together when one changes | `fact`, from cross-root calls and shared entities |

**Requirement**: every entry gives a specific module or file and the dependency path; an overall characterization that cannot be checked **MUST NOT** be given. If no circular dependency is found, the report **MUST** say so explicitly — omitting it reads as "not checked". Direct data access that bypasses an interface **MUST** be listed separately: that path skips the owner's validation.

---

# Specialist

## 7. Problems and risks

Grouping and prohibitions: `contract.md` section 5.

### 7.1 Defects that resolve to an exact location `fact`

* The same permission predicate used with inconsistent polarity across its call sites
* Keys, credentials and external addresses hardcoded in source
* Errors caught and then neither logged nor rethrown
* External calls made inside a transaction
* External calls with no declared timeout

### 7.2 Structural contradictions `fact`

* More than one source root writing the same entity
* One side reading what another writes, with no interface between them
* An entity declared with different structures in different source roots
* The same path declared by more than one source root
* An old and a new path coexisting for one business, with differing validation or error responses
* Circular dependencies

### 7.3 Code-shape problems `fact`

* Data queries inside a loop
* Queries with no filter
* List queries with no pagination
* Reading a full set and filtering it in memory

### 7.4 Code with no reachable entry point `fact`

Fully implemented code for which reachability analysis finds no entry.

### 7.5 Absences established by search `verified`

The loop: `contract.md` section 6.

## 8. Build, run and test as they stand

**State what exists. MUST NOT state what ought to exist.**

| Question | Marker |
| -- | -- |
| Build and start commands | `fact`, from scripts declared in the dependency manifest |
| Dependency management and lock files | `fact` |
| Continuous integration configuration and the steps it runs | `fact` where the configuration is in the repository |
| External services and credentials needed to run | `fact`, see chapter 5 |
| How database changes are organized | `fact`, from migration files |
| Distribution and count of test files per source root | `fact` |
| Which modules and call paths the tests cover | `fact` |
| Which modules have no test found | `fact` |
| How tests are organized and where they live | `fact` |
| Release permissions, approvals, staged rollout and rollback | `unavailable` |

**Requirement**: no test file found does not mean no tests exist; that statement **MUST** go in chapter 9.

## 9. Coverage and analysis boundary

Requirements: `contract.md` section 8.

### 9.1 What was read `fact`

| Item | Content |
| -- | -- |
| Source snapshot | Each repository's revision, whether it had uncommitted changes, analysis time |
| Read scope | Files read, files not read and why |
| Resolution depth | Share of entry points traceable, share of call chains terminating early, share of unresolved external calls |
| Evidence sufficiency per chapter | Evidenced / checked-and-not-found / not executed / not determinable from static source |

### 9.2 Unsafe assumptions

Requirements: `contract.md` section 9. Examples:

* The call paths given are not the paths production actually executes. Static analysis cannot know runtime branch selection or switch states.
* An endpoint existing in code does not mean it is exposed in production. A route declaration and actual exposure are different things.
* No test found for a module does not mean the module is unverified.
* Several source roots using the same database technology does not mean they connect to the same instance.
* Chapter 6 stating that no circular dependency was found applies to resolved calls only; the unresolved share is in 9.1.
* The report not listing a problem does not mean it does not exist, only that static source review found no evidence of it.

### 9.3 Questions this report does not answer

| Question | Data source to consult |
| -- | -- |
| Production topology, gateways, domains, instance counts, orchestration | Deployment configuration and the operations platform |
| Actual request volume, latency, error rate, resource use | Application performance monitoring |
| Database instance layout, replicas, real index state, slow queries | Database operations |
| Alert rules, thresholds and recipients | Monitoring platform |
| Release permissions, approvals, staged rollout and rollback | Delivery pipeline |
| Recent incidents and open issues | Incident records |
| Dependency vulnerabilities and production security configuration | Security scanning |
| Ownership of each module | Team records |

---

## Appendix: acceptance criteria (pipeline gate; not part of the report)

The report should be able to answer:

* Which source roots the project comprises, with their stacks and declared runtime versions
* Which business capabilities it provides, used by which roles, sitting in which source roots
* Which symbols a request traverses from entry to storage, at which layer authentication and authorization happen, and where the path breaks
* Who writes and who reads each data entity, and which entities have several writers or inconsistent declarations
* Which external services are integrated, with their purpose, failure handling and required credentials
* Dependency direction between source roots and modules, and where interfaces are bypassed
* Which locatable defects and structural contradictions exist, and the basis for each
* How to build and run it, and which modules the existing tests cover
* Which conclusions are evidenced and which are genuinely unavailable
* Which questions this report does not answer and where to look instead
