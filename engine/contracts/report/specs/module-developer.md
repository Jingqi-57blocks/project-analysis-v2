---
id: module-developer
scope: module
audience: developer
inherits: contract.md
version: 1.0.0
title: Module detail, technical
requires:
  - auth-annotation
  - business-rule
  - call-edge
  - condition
  - coverage-note
  - cross-root-link
  - data-access
  - decision
  - discarded-error
  - entity
  - entity-constraint
  - entity-field
  - entity-relation
  - error-handling
  - feature
  - feature-flow
  - guard
  - module
  - module-containment
  - notification-call
  - outbound-call
  - route
  - run-context
  - scheduled-task
  - state
  - structural-finding
  - symbol
  - test-relation
  - trace
  - transaction-boundary
  - transition
  - validation-rule
  - value-set
---

# Module detail, technical

> Audience: engineering leads, architects, senior developers.
> Goal: without starting the system, be able to explain one module's code boundary, execution paths, data effects, external dependencies and blast radius.

Writing rules are inherited from `contract.md`. This spec defines only what to write.

Chapters are ordered by when the questions arise while taking on a change to the module, mirroring `project-developer` — one way of reading, from project level down to module level, with no switch of structure.

The technical report **includes** the business description; it is not a parallel view alongside the non-technical one. A developer also has to understand what the module does for the business before they can judge what a change means. The difference is that business content is **context** here and **MUST** be presented against code locations; standalone business narrative belongs to `module-product`.

## Scope and granularity

**One module, one report.** A module is one capability from `project-developer` chapter 2.

Leave is a module; submit, approve and withdraw are call paths within it. Multiple paths appear in chapter 2 in parallel and **MUST NOT** be split into separate reports — splitting loses both the state handoff between paths and their shared transaction boundaries.

A module's boundary is decided by code ownership and call relationships, **MUST NOT** by directory name. A module **MAY** span source roots.

## Reading layers

| Layer | Chapters | Use |
| -- | -- | -- |
| **Essential** | 0–2 | Business responsibility, code boundary, execution paths |
| **On demand** | 3–5 | Look up a specific question |
| **Specialist** | 6–9 | Change assessment, troubleshooting, verification, analysis boundary |

---

# Essential

## 0. Module responsibility and glossary

### Responsibility `fact`

| Question | Marker |
| -- | -- |
| What this module does for the business | `fact`, from entry-point names, UI strings and business objects |
| Which business objects it involves | `fact` |
| Which roles use it | `fact`, from permission checks declared on entry points |
| Which business paths it contains | `fact` |
| Current status | `fact` (reachable / no entry point / explicitly deprecated or unfinished / behind a switch / unconfirmed) |

**Requirement**: this section supplies the context the later technical chapters need and **MUST** stay short enough to read in one pass. The full business narrative belongs to `module-product`.

### Module glossary `fact`

Format and requirements: `contract.md` section 7.

**Requirement**: the glossary **MUST** come first. Module-level abbreviations often differ from project-level ones and **MUST** be given separately.

## 1. Code boundary and entry points

| Question | Marker |
| -- | -- |
| Which files and symbols the module comprises | `fact` |
| Which source roots it spans | `fact` |
| How the boundary was decided | `fact` |
| External entry points: API, page route, message consumer, scheduled job, external callback | `fact` |
| The handler behind each entry point | `fact` |
| The middleware on each entry point and its execution order | `fact` |
| Who the callers are | `fact` |
| Ownership | `unavailable` |

**Requirement**: the basis for the boundary **MUST** be listed. A shared route file or utility module **MUST NOT** widen the module — the boundary follows ownership and call relationships, not file location.

## 2. Business steps against call paths

**The core chapter.** Each business path in the module is expanded in turn, with business steps and code locations **aligned segment by segment**.

| Business step | Code location | Branches and conditions |
| -- | -- | -- |

| Question | Marker |
| -- | -- |
| The business steps of each path | `fact` |
| The symbol and file behind each step | `fact` |
| Where branches and early returns occur, and on what condition | `fact` |
| Each terminal path (success, rejected, cancelled, error) and its code location | `fact` |
| The boundary between synchronous and asynchronous | `fact` |
| At which step a cross-root call happens | `fact` |
| Side effects not evident from the function names | `fact` |
| Which steps are driven by a scheduled job or external callback | `fact` |
| Where tracing stopped and why | `fact` |

**Requirement**:

* **Business steps and code locations MUST align segment by segment.** This is what distinguishes this report from both the non-technical version and a plain code listing — neither alone supports a change decision.
* Where tracing stops, the report **MUST** mark the stopping point and the reason (dynamic construction, unresolved reference, cross-language boundary, reflection) and **MUST NOT** stitch a path that looks complete but is partly guessed.
* **The state handoff between paths MUST be given** — one path's terminal state is another's starting state.

---

# On demand

## 3. Business rules and where they are implemented

| Question | Marker |
| -- | -- |
| Which validation rules, triggers and outcomes the module has | `fact` |
| The state set and its transitions | `fact` |
| Which symbol triggers each transition | `fact` |
| Preconditions for create, modify, delete | `fact` |
| The exact location of each permission check | `fact` |
| **Where each rule is implemented** | `fact` |
| Where one rule has several implementations, whether thresholds, comparison operators and boundary conditions agree | `fact` |
| The source of each rule's value set (constant, enum, database constraint) | `fact` |

**Requirement**:

* **"Where each rule is implemented" is this chapter's core output.** A rule that exists simultaneously in the front end, entry validation, business logic, a database constraint and a scheduled job means any single edit can leave the rest inconsistent. Every implementation site **MUST** be listed.
* Where implementations disagree, this chapter states the difference only; the determination belongs in chapter 7.

## 4. Data model and read/write paths

| Data object | Key fields | Constraints | Written here | Read here | Accessed by other modules |
| -- | -- | -- | -- | -- | -- |

| Question | Marker |
| -- | -- |
| Which entities, fields and types are involved | `fact` |
| Primary keys and unique constraints | `fact` |
| Relationships between entities | `fact` |
| Where this module reads and where it writes | `fact` |
| Which entities other modules also read and write directly | `fact` |
| Which entities other source roots read and write directly | `fact` |
| Soft-delete and audit fields | `fact` |
| Fields matching a sensitive-term list, passing through encryption, or guarded by a permission check | `fact` |
| Indexes | `fact` where declared in code or migrations; otherwise `unavailable` |
| Cache and search | `fact` where a matching client call exists; otherwise "not applicable" |
| Archival and retention | `unavailable`, unless a cleanup job exists |

**Requirement**: "also read and written by other modules" **MUST** give the specific module and code location — that path does not pass through this module's validation.

## 5. Side effects and external dependencies

Everything one operation causes beyond changing this module's own data.

### 5.1 Internal side effects `fact`

Which other modules' entities are written or changed, which state transitions are triggered, whether an audit record is written, whether other modules' logic is triggered.

### 5.2 Notifications `fact`

Which notifications are sent, over which channel, to whom, at which step of the path, and how a send failure is handled.

### 5.3 External service calls `fact`

| External service | Purpose | Call site | Sync / async | Timeout and retry | Failure handling | Credentials |
| -- | -- | -- | -- | -- | -- | -- |

| Question | Marker |
| -- | -- |
| Which external services this module calls | `fact` |
| What each call sends and receives | `fact` |
| Purpose | `fact`, from the call site's context; "undetermined" where it cannot be read |
| Declared timeouts and retry counts | `fact` where they are literals |
| Failure handling: error, retry, degrade, silently ignore | `fact` |
| Whether a degradation branch exists | `fact` |
| Whether the call is made inside a transaction | `fact` |
| Cost, quota, alternatives | `unavailable` |

### 5.4 Messages and scheduled jobs `fact`

Messages produced or consumed; scheduled and background jobs with their schedule expressions where these are literals; job entry points; dead-letter and manual-compensation entry points.

**Requirement**: every site marked "silently ignored" **MUST** name the file and line.

---

# Specialist

## 6. Blast radius

| Question | Marker |
| -- | -- |
| Which symbols call this module directly | `fact` |
| Which cross-root calls would be affected | `fact` |
| Which pages and endpoints consume this module's responses | `fact` |
| Which other modules read and write this module's entities directly | `fact` |
| Which scheduled jobs or message consumers depend on it | `fact` |
| Which external systems would notice a change | `fact` |
| The length of each impact path (direct call or via an intermediary) | `fact` |
| Which source roots must be released together when this module changes | `fact`, from cross-root calls and shared entities |

**Requirement**: order by breadth of impact. Paths that reach the data while bypassing this module **MUST** be called out separately — they skip all of its validation and are the dependency most easily missed during a change.

## 7. Problems and risks

Grouping and prohibitions: `contract.md` section 5.

### 7.1 Defects that resolve to an exact location `fact`

* The same permission predicate used with inconsistent polarity across its call sites in this module
* A path that bypasses permission or data-isolation limits
* Hardcoded keys, credentials and external addresses
* Errors caught and then neither logged nor rethrown
* External calls made inside a transaction
* External calls with no declared timeout
* Partial-success paths, where data is written but a later side effect fails with no compensation

### 7.2 Structural contradictions `fact`

* One rule implemented in several places with differing thresholds or boundaries
* This module's entities written directly by other modules, bypassing its interface
* An old and a new entry point coexisting for one business, with differing validation or error responses
* An entity declared with different structures in different source roots

### 7.3 Code-shape problems `fact`

* Data queries inside a loop
* Queries with no filter
* List queries with no pagination
* Long transactions spanning several external round trips

### 7.4 Code with no reachable entry point `fact`

Code inside this module that is fully implemented but for which reachability analysis finds no entry.

### 7.5 Absences established by search `verified`

The scenario list (business-agnostic failure modes; this list may be fixed):

double submission by one user · concurrent modification of one object · duplicate message consumption · a scheduled job running on several instances · duplicate delivery of an external callback · a request that timed out but actually succeeded · data changed between read and write · empty data · invalid input · record already deleted · external service failure · partial success · oversized data · monetary precision · timezone and date boundaries

The loop: `contract.md` section 6. Within this module, search locks, unique constraints, state checks, idempotency keys, conditional updates and error handling.

**Requirement**: the general failure-mode list **MAY** be fixed; **expected business rules MUST NOT be fixed** — they must be derived on the spot from this module's entities and states.

## 8. Tests as they stand

**State what exists. MUST NOT state what ought to exist.**

| Question | Marker |
| -- | -- |
| Which tests exist for this module and where they live | `fact` |
| Which of chapter 2's call paths they cover | `fact` |
| Which branches and terminal states they cover | `fact` |
| Which paths have no test found | `fact` |
| How the tests are organized | `fact` |
| Whether they run in continuous integration | `fact` where the configuration is in the repository |
| Whether the tests are stable or skipped | `unavailable` |

**Requirement**: no test found does not mean the path is unverified; that statement **MUST** go in chapter 9.

## 9. Coverage and analysis boundary

Requirements: `contract.md` section 8.

### 9.1 What was read `fact`

| Item | Content |
| -- | -- |
| Module boundary | Which files and symbols it comprises, which source roots it spans, how that was decided |
| Source snapshot | Repository revisions, whether they had uncommitted changes, analysis time |
| Read scope | Files read within the module's boundary, files not read and why |
| Resolution depth | Share of this module's entry points traceable, where call chains terminated early, unresolved calls |
| Evidence sufficiency per chapter | Evidenced / checked-and-not-found / not executed / not determinable from static source |

**Requirement**: every metric **MUST** carry its denominator and the specific locations.

### 9.2 Unsafe assumptions

Requirements: `contract.md` section 9. Examples:

* The call paths given are not the paths production actually executes. Static analysis cannot know runtime branch selection or switch states.
* Section 7.5 finding no handling for a scenario does not mean production will fail. A unique constraint, gateway handling or a manual process may intercept it.
* No test found for a path does not mean the path is unverified.
* An endpoint existing in code does not mean it is exposed in production.
* The report not listing a problem does not mean it does not exist, only that static source review found no evidence of it.

### 9.3 Questions this report does not answer

| Question | Data source to consult |
| -- | -- |
| This module's actual request volume, latency and error rate | Application performance monitoring |
| Configuration and switch states actually in effect in production | Configuration service |
| Database instances, real index state and slow queries | Database operations |
| Whether alerts are configured, with what thresholds and recipients | Monitoring platform |
| Release order, rollout strategy and rollback | Delivery pipeline |
| Recent production problems in this module | Incident records |
| Ownership | Team records |

---

## Appendix: acceptance criteria (pipeline gate; not part of the report)

For any functional module, the report should be able to answer:

* What the module does for the business and which roles use it
* Which files and symbols its code boundary comprises, and which source roots it spans
* Which call paths it has, how business steps map to code locations, and where a path breaks
* Where validation, state and permission rules are implemented, and whether multiple implementations agree
* Which entities it reads and writes, and which are reached directly by other modules
* Which internal side effects, notifications and external calls one operation causes, and how failures are handled
* Which symbols, pages, modules and external systems a change would reach
* Which locatable defects and structural contradictions exist, and the basis for each
* Which paths the existing tests cover
* Which conclusions are evidenced and which are genuinely unavailable
* Which questions this report does not answer and where to look instead
