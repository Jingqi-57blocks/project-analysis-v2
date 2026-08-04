---
id: feature-product
scope: feature
audience: product
version: 1.0.0
title: Feature detail, non-technical
---

# Feature detail, non-technical

> Audience: product managers, business owners, operations leads.
> Goal: explain one capability's normal behaviour, its exceptional behaviour, and
> what changing it would affect — without reading code.

How to write and how to investigate: `engine/contracts/report/writing-rules.md`.
This spec defines only the subject, the chapters, and what belongs in each.

---

## Resolving the subject

The invocation names a **business capability** in the reader's words. It is not a
key in the base, and the base's own grouping is not the answer: groupings computed
from term overlap split one capability across several entries, put related storage
under a different entry, and leave scheduled work attached to none of them.

Resolve it in the census pass, in this order:

1. **Seed** — entries whose name or term matches the subject.
2. **Expand along shared storage** — entries reading or writing the same stored
   objects as the seed.
3. **Expand along file overlap** — entries whose rows sit in the same files.
4. **Expand along state** — value sets and transitions declared inside the seed's
   files, including ones named for a different concept. A lifecycle enum living
   inside another capability's service file belongs to whichever capability drives
   it, not to the one that named it.
5. **Expand along scheduled work** — scheduled tasks touching the files above.
   Scheduled work frequently belongs to no computed entry at all and would otherwise
   be lost.

The union is the report's subject. Do not widen further: an entry that merely shares
a generic object such as the user record is not part of this capability.

**Chapter 1 MUST state the resolved boundary**, marked `inferred`, listing the ids it
comprises and naming what was deliberately excluded and why. A reader who disagrees
with the boundary can then see exactly what to argue with. **MUST NOT** hardcode any
particular project's answer — the rule above is the whole of it.

Where the boundary is genuinely ambiguous — a step that belongs equally to two
capabilities — say so, put it in this report, and note the overlap.

---

## Chapters

### 1. Basic information

What this capability is, in one sentence. Which business domain it sits in, who uses
it, where they enter it, what must be true before they can, and its status from the
four decidable values (behind a switch, unfinished, deprecated, unconfirmed).

Then the resolved boundary, per the section above.

### 2. User flow

Where the user enters, the steps they take, what choices each step offers, what
happens on success, what they are told on failure, whether they can undo, retry or go
back, whether approval is required, and where the flow differs by role.

Steps come from traced flows and entry points; **MUST NOT** be assembled from
endpoint names alone. Where the trace terminated early, say which step is the last
one evidenced rather than completing the story.

### 3. Business rules

| Rule | When it applies | What happens | Exceptions |
| -- | -- | -- | -- |

Cover required fields and formats; limits on amount, quantity, time and count;
uniqueness; ordering; calculations; approval rules; automatic and timeout handling;
cancellation and reversal; and where rules differ by role, region or customer.

Each rule cites where it is enforced. Where the same rule is enforced in more than
one place with different boundaries, say so here and carry it into chapter 10.

### 4. States and lifecycle

Every state, the initial and terminal ones, what moves the object between them, who
triggers each move, whether it is automatic or manual, whether it is reversible, and
what else changes as a side effect. Output a state diagram in Mermaid, labelled in
the target language.

Where more than one part declares states for the same object, show both and say which
declares more — a difference between them is a finding for chapter 10.

### 5. Permissions and data scope

Who can view, create, change, delete, approve, export and act in bulk; who can act on
another person's records; whether records are partitioned by organization; and
whether any role bypasses those limits.

Say which layer the answer covers. Where authorization is decided inside handler
bodies rather than declared at the entry point, an absence here is not an absence of
control, and the report **MUST** say so.

### 6. Data and fields

| Field | What it means | Where it comes from | Editable | Sensitive |
| -- | -- | -- | -- | -- |

Which stored objects this capability touches, what the key fields mean, whether each
is entered by a user, computed, or synchronized from outside, default values,
retention, how deletion works, and which other capabilities read the same data.

Business names in the body; raw identifiers in the evidence layer and glossary.

### 7. Notifications and side effects

What one operation sets off: in-app messages, email, push, balance or billing
changes, permission changes, audit records, data synchronization, external calls.

Recipients and message contents are runtime values and are `unavailable`; the call
site and its channel are `fact`. Say which is which.

### 8. Exceptions and boundaries

Work the business-agnostic failure modes through the hypothesize–search–decide loop:
empty input, invalid input, double submission, concurrent modification, permission
changed mid-flow, record already deleted, partial success, oversized data, amount
precision, and date or time-zone boundaries.

For each: what the code does, what the user is told, what state the data is left in,
and whether it can be retried. All three verdicts are reportable — a search that
found no guard, on a kind with rows, is an evidenced absence and says which rows were
searched.

Network interruption, request timeout and external-service failure are only
answerable where the code declares handling for them; where it does not, that is
`unavailable`, not "unhandled".

### 9. Configuration and switches

Which configuration affects this capability, its default, whether behaviour differs
by environment or customer, what a switch covers, and what the code does when it is
off. From `config-key` and configuration-driven conditions.

### 10. Risks and blast radius

Format, grouping and priority: `writing-rules.md`.

Then **what changing this capability would affect**: which entry points, stored
objects, scheduled work and other capabilities read or write what this one does. This
is a reachability statement from the base, marked `fact`, not a prediction — it says
what is connected, not what would break.

### 11. Glossary

Three columns, per `writing-rules.md`, limited to terms this report uses.

### 12. Coverage and what this report does not answer

What was read and how completely, each figure with its denominator. Which tests
exercise this capability, from `test-relation` and `test-name`, and which of its
flows no test covers.

The exclusion table: response times and data volumes, production configuration,
actual usage, retention and compliance requirements, ownership — and every checklist
item that ended `cannot be determined here`, each with its reason.

---

## Appendix: acceptance criteria (pipeline gate; not part of the report)

* Chapter 1 says in one sentence what this capability is, and states its resolved
  boundary with the ids it comprises and what was excluded.
* Chapter 2's steps trace to flow evidence, not to endpoint names.
* Chapters 3, 4 and 5 each say which layer their answer covers.
* Every checklist item appears with a verdict; every non-empty verdict cites ids that
  exist in the base.
* At least one finding came from `open` and is not a pre-computed
  `structural-finding` row.
* Chapter 10's blast radius is a reachability statement, not a prediction.
* Every coverage figure carries its denominator.
