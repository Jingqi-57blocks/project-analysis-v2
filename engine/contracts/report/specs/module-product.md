---
id: module-product
scope: module
audience: product
inherits: contract.md
version: 1.1.0
title: Module detail, non-technical
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
  - error-handling
  - feature
  - feature-flow
  - guard
  - module
  - notification-call
  - outbound-call
  - route
  - run-context
  - state
  - structural-finding
  - test-relation
  - trace
  - transaction-boundary
  - transition
  - validation-rule
  - value-set
---

# Module detail, non-technical

> Audience: product managers, business owners, operations leads.
> Goal: without reading code, be able to explain one functional module's behaviour, rules, data effects and blast radius.

Writing rules are inherited from `contract.md`. This spec defines only what to write.

Companion to `project-product`: the overview answers "what the project is made of and how capabilities relate"; this spec answers "how one of them actually works".

## Scope and granularity

**One module, one report.** A module is the third level of the overview's capability map:

```text
project → business domain → functional module → capability
                            ^ the scope of this report
```

Leave is a module; submit, approve and withdraw are capabilities within it. Multiple capabilities appear in chapter 2 as parallel flows and **MUST NOT** be split into separate reports — splitting loses the state handoff between them.

A module's boundary is decided by code ownership and call relationships, **MUST NOT** by directory name. A module **MAY** span repositories; when it does, slicing **MUST** gather the module across roots and **MUST NOT** truncate at a root boundary.

## Reading layers

| Layer | Chapters | Use |
| -- | -- | -- |
| **Essential** | 1–2 | What this module is and how it is used |
| **On demand** | 3–7 | Look up a specific question; skimmable |
| **Specialist** | 8–13 | Failure-mode check, blast radius, troubleshooting, analysis boundary |

---

# Essential

## 1. What this module is

| Question | Marker |
| -- | -- |
| Module name and business domain | `fact` for the name; `inferred` for the domain |
| What this module does, in two or three sentences | `inferred` — the reader needs this before anything else |
| Which business objects it involves | `fact` |
| Which roles can reach its entry points | `fact` |
| Where it is entered from (page, API, scheduled job, external callback) | `fact` |
| Which surfaces it covers (employee-facing, admin console, mobile) | `fact`, from the host repository of each entry |
| Preconditions (what data or state must exist first) | `fact` |
| Current status | `fact`, one of the four below |
| Which other modules depend on it | `fact` |

Status uses only the four source-decidable values; anything else is "unconfirmed":

| Status | Basis |
| -- | -- |
| Reachable entry point | An entry exists and the call chain is reachable |
| Code with no entry point | Reachability analysis finds no entry |
| Explicitly deprecated or unfinished | deprecated marker, unimplemented branch, TODO |
| Behind a switch | Wrapped in a feature-flag condition |

### Module glossary `fact`

Format: `contract.md` section 7.

**Requirement**: the glossary **MUST** come first in the report. Module-level abbreviations often differ from project-level ones and **MUST** be given separately.

## 2. Which flows this module has

**The core chapter.** Each capability in the module is one flow, expanded in turn.

| Question | Marker |
| -- | -- |
| Who initiates it | `fact` |
| Which entry point it starts from | `fact` |
| The main steps of the happy path | `fact` for the steps; `inferred` for what the flow accomplishes |
| The condition and branches at each step | `fact` |
| Which terminal states it reaches (success, rejected, cancelled, error) | `fact` |
| Which steps are automatic and which need a person | `fact`; scheduled jobs and triggered calls are distinguishable |
| What state the data is left in when it fails midway | `fact` |
| Whether it can be undone, retried or stepped back | `fact`, from the reversibility of the state transitions |
| How the path differs by role | `fact`, from branches created by permission checks |
| Where tracing stopped and why | `fact` |

**Output**: one diagram per flow, with branches and every terminal path.

**Requirement**:

* Branch labels use the target language (condition, success, rejected, error) and **MUST NOT** expose the code's own enum spellings.
* The state handoff between flows **MUST** be given — the terminal state of "submit" is the starting state of "approve".
* Where tracing stopped, the report **MUST** mark the stopping point and the reason, and **MUST NOT** stitch together a flow that looks complete but is partly guessed.
* The basis for ordering the flows **MUST** be stated. What static analysis can offer is "most steps, widest cross-module reach, touched by the most roles".
* State-transition diagrams are reconstructed from state assignments in code; the report **MUST** state that a transition missing from the diagram is not necessarily disallowed by the business — it may be written in a form the analyzer cannot read.

---

# On demand

## 3. Business rules

| Rule | Trigger | Outcome | Exceptions |
| -- | -- | -- | -- |

Covers: required fields and formats; quantity, amount and time limits; uniqueness and deduplication; calculations; review rules; timeouts and automatic handling; cancellation and rollback; differences by role, region or customer.

| Question | Marker |
| -- | -- |
| The rule itself and its trigger | `fact` |
| What happens when it is violated | `fact` |
| The calculation | `fact`; **MUST** be translated into business language, **MUST NOT** paste the code expression |
| Exceptions | `fact` |
| Where each rule is implemented | `fact` |
| Where one rule has several implementations, whether their thresholds and boundaries agree | `fact` |

**Requirement**: one rule per row. Where implementations disagree, this chapter states the difference only; the determination belongs in chapter 10.

## 4. Permissions and data scope

| Question | Marker |
| -- | -- |
| Who can view, create, modify, delete | `fact` |
| Who can review, export, bulk-operate | `fact` |
| Who can act on other people's data | `fact` |
| How data is isolated (own, department, project, company) | `fact`, from query filters |
| **Whether any role or path bypasses those limits** | `fact` |

**Output**: the module's permission matrix — role × operation.

**Requirement**: the last row **MUST** be called out separately. Administrator bypass, unauthenticated internal endpoints and public share links all belong here; it is what the reader most needs and what is most easily missed.

## 5. Data and fields

| Question | Marker |
| -- | -- |
| Which business objects are involved | `fact` |
| Which UI strings and enums the key fields appear in | `fact` |
| Where the data comes from (user input, system calculation, external sync) | `fact` |
| Which fields can change and who changes them | `fact` |
| Default values | `fact` |
| How deletion works (soft or physical) | `fact` |
| Fields matching a sensitive-term list, passing through encryption, or guarded by a permission check | `fact` |
| Which objects other modules also read and write directly | `fact` |
| Data retention period | `unavailable`, unless a cleanup job is declared in code |

**Requirement**: use business names, **MUST NOT** use database table names. "Also read and written by other modules" **MUST** name the specific modules — that path does not pass through this module's validation.

## 6. Notifications and side effects

| Question | Marker |
| -- | -- |
| Which notifications are sent (in-app, email, SMS, push) | `fact` |
| Who receives them and at which step | `fact` |
| Which other business objects are written or changed | `fact` |
| Which external systems are called and why | `fact`; purpose from the call site's context, "undetermined" where it cannot be read |
| Whether an audit record is written | `fact` |
| How a failing side effect is handled (error, retry, degrade, silently ignore) | `fact` |

**Requirement**: the last row **MUST** be given per item, and anything marked "silently ignored" **MUST** name the exact location.

## 7. Upstream and downstream

| Question | Marker |
| -- | -- |
| Which modules this one calls | `fact` |
| Which modules call this one | `fact` |
| Which modules share a business object with it | `fact` |
| For each shared object, who writes and who only reads | `fact` |
| Whether this module is implemented across repositories | `fact` |

**Output**: the module's upstream/downstream diagram.

---

# Specialist

## 8. Failure-mode check `verified`

Check, one by one, whether the code handles each general failure mode. **MUST NOT** list what ought to be handled.

The scenario list (business-agnostic failure modes; this list may be fixed):

empty data · invalid input · double submission · concurrent modification · permission change mid-operation · record already deleted · request timeout · external service failure · partial success · file upload failure · oversized data · monetary precision · timezone and date boundaries · user abandoning midway

The loop: `contract.md` section 6.

**Requirement**: the general failure-mode list **MAY** be fixed; **expected business rules MUST NOT be fixed** — they must be derived on the spot from this module's objects and states.

## 9. Blast radius `fact`

| Question | Marker |
| -- | -- |
| Which pages are affected | `fact` |
| Which other modules' flows depend on this module's result | `fact` |
| Which reports or exports use this module's data | `fact` |
| Which external systems would notice a change | `fact` |
| Which data objects other modules read and write directly | `fact` |
| The length of each impact path (direct call or via an intermediary) | `fact` |

**Requirement**: order by breadth of impact. Paths that reach the data while bypassing this module **MUST** be called out separately — they skip all of this module's validation.

## 10. Problems and risks

Grouping and prohibitions: `contract.md` section 5.

### 10.1 Problems that resolve to an exact location `fact`

* A path that bypasses permission or data-isolation limits
* The same permission check written inconsistently across its uses in this module
* Errors that are caught and then neither logged nor reported
* External calls made inside a transaction
* External calls with no declared timeout
* Partial-success paths, where data is written but a later side effect fails with no compensation

### 10.2 Structural contradictions `fact`

* One rule implemented in several places with differing thresholds or boundaries
* This module's data written directly by other modules, bypassing its interface
* One business with both an old and a new entry point whose validation or error responses differ

### 10.3 Code with no reachable entry point `fact`

Parts of this module that are fully implemented but for which reachability analysis finds no entry. The search scope for callers **MUST** be stated.

### 10.4 Absences established by search `verified`

The scenarios chapter 8 judged an evidenced absence, with the checked locations.

## 11. Existing test coverage `fact`

**State what is tested now. MUST NOT state what ought to be tested.**

| Question | Marker |
| -- | -- |
| Which tests exist for this module | `fact` |
| Which of chapter 2's flows they cover | `fact` |
| Which branches and terminal states they cover | `fact` |
| Which flows have no test found | `fact` |

**Requirement**: no test found does not mean no protection in production; that statement **MUST** go in chapter 12.

## 12. Unsafe assumptions

Requirements: `contract.md` section 9. Examples:

* Chapter 8 found no handling for a scenario — that does not mean production will break. The UI, a database constraint or a manual process may stop it first.
* The permission matrix is not the complete set of authorization paths. Checks scattered through handler bodies are certain to be missed by static search.
* A flow has no matching test — that does not mean it was never verified. The test may live outside the repository, or the check may be manual.
* The report does not list a problem — that does not mean it does not exist, only that static source review found no evidence of it.

## 13. Coverage and analysis boundary

Requirements: `contract.md` section 8.

### 13.1 What was read `fact`

| Item | Content |
| -- | -- |
| Module boundary | Which code it comprises, which repositories it spans, how that was decided |
| Source snapshot | Repository revisions, whether they had uncommitted changes, analysis time |
| Read scope | Files read within this module's boundary, files not read and why |
| Resolution depth | Share of this module's entry points traceable, where flows terminated early, unresolved calls |
| Evidence sufficiency per chapter | Evidenced / checked-and-not-found / not executed / not determinable from static source |

**Requirement**: every metric **MUST** carry its denominator and the specific locations.

### 13.2 Questions this report does not answer

| Question | Data source to consult |
| -- | -- |
| This module's actual usage and frequency | Analytics and business data |
| Configuration and switch states actually in effect in production | Configuration service |
| Problems and complaints users actually hit | Support system |
| Recent production incidents in this module | Incident records |
| Data retention and compliance requirements | Legal and compliance |
| Ownership | Team records |

---

## Appendix: acceptance criteria (pipeline gate; not part of the report)

For any functional module, the report should be able to answer:

* What this module does, which roles can reach it, and where it is entered from
* Which flows it has and which terminal states each reaches
* Which business rules and limits apply, and whether any rule is implemented more than once
* Who can do what, whose data they can see, and whether a bypass path exists
* Where the data comes from, who can change it, what deletion does, and who else touches the same data
* What else happens as a result of one operation, and how a failing side effect is handled
* Which modules it depends on and which depend on it
* Which common failure modes the code handles
* What changing it would affect
* Which locatable problems exist and the basis for each
* Which flows the existing tests cover
* Which conclusions are evidenced and which are genuinely unavailable
* Which conclusions the reader should not draw
