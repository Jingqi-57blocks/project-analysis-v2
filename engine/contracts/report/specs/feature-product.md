---
id: feature-product
scope: feature
audience: product
version: 2.1.0
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

Twelve, in this order, numbered. Every chapter is built the same way: a short
paragraph answering the chapter's question, then **bolded lead-ins** naming each
sub-question, then the chapter's closing synthesis.

The project overview gave this capability one line. This is where a reader who
wanted more comes, so give them the thing properly.

## 1. What this capability is, and where its edges are

Two parts, then the boundary.

**What it is** — more than the overview's sentence: what it is for, and where it
sits in the product. Someone who has never heard the capability's name should finish
this paragraph knowing what it means in this system.

**What you can do with it** — the actions, in plain words. A write to a leave path
is *requesting leave*; a read of one by id is *looking a request up*; a write to an
approve path is *approving one*. Write the list of things a person can do, not the
list of entry points that do them. Where several entry points are one action from a
user's point of view, say it once.

**The same test chapter 1 of an overview must pass applies here:** delete every
marker, parenthetical and citation. What is left has to tell a business reader what
this capability is. If deleting the evidence leaves nothing, it was answered, not
written.

Then, each under its own bolded lead-in:

* **Who uses it** and what each of them comes here to do.
* **Where they enter it** — in the words of the interface, not as paths.
* **What must be true first** — preconditions the code enforces before the capability
  is usable at all.
* **Status** — one of the four decidable values: behind a switch, unfinished,
  deprecated, unconfirmed.
* **What this report covers** — the resolved boundary, per the section above: the ids
  it comprises, and what was deliberately left out and why.

## 2. How a person uses it

The journey, in order: where they come in, what they do at each step, what choices
each step offers, what happens on success, what they are told on failure, whether
they can undo, retry or go back, whether anyone has to approve, and where the journey
differs by role.

Steps come from traced flows and entry points and **MUST NOT** be assembled from
entry-point names alone. Where a trace stopped early, name the last step that is
evidenced and say the rest was not established. Writing around the gap is worse than
the gap: "nothing beyond the entry point was established for these" is a good
sentence.

## 3. The rules it enforces

| Rule | When it applies | What happens | Exceptions |
| -- | -- | -- | -- |

Cover required fields and formats; limits on amount, quantity, time and count;
uniqueness; ordering; calculations; approval rules; automatic and timeout handling;
cancellation and reversal; and where rules differ by role, region or customer.

**Lead with disagreement.** Where the same rule is enforced in more than one place
with different boundaries, or where two parts declare it differently, that goes first
in this chapter and again in chapter 10 — a rule the system does not agree with
itself about is the most useful thing on the page.

Each rule says where it is enforced. A rule stated without that is a guess.

## 4. States and lifecycle

Every state, the initial and terminal ones, what moves a record between them, who
triggers each move, whether it is automatic or manual, whether it is reversible, and
what else changes as a side effect. Output a state diagram, labelled in the target
language.

Where more than one part declares states for the same record, show both and say which
declares more. A difference between them is a finding for chapter 10.

## 5. Who can do what, and see what

Under lead-ins: **who can view**; **who can create, change and delete**; **who can
approve, export and act in bulk**; **who can act on another person's records**;
**whether records are partitioned by organisation**; **whether any role bypasses
those limits**.

**The honest boundary — this is the most important part of the chapter.** What is
read here is authorisation *declared* at the entry point. A permission enforced by a
condition inside a handler is invisible to it. So:

* Where entry points show only a sign-in check and no roles, **MUST NOT** conclude
  that anyone signed in can do everything. Say what is true: no finer permission is
  declared at the boundary, so any role restriction is enforced inside the handlers,
  in code this analysis cannot read. For something like an approval flow that inline
  logic almost certainly exists — this report simply cannot see it.
* An entry point with no check declared is "no check declared", never "provably
  open".

State this limit plainly, under its own lead-in. It is the difference between a
description and an accusation.

## 6. Data and fields

| Field | What it means | Where it comes from | Editable | Sensitive |
| -- | -- | -- | -- | -- |

Under lead-ins: **which records this capability touches**; **what the key fields
mean**; **where each value comes from** — entered by a user, computed, or synchronized
from outside; **what happens on deletion**; **which other capabilities read the same
data**.

Business names in the body; raw identifiers in the evidence layer and the glossary.
Retention is `unavailable` unless a scheduled cleanup declares it.

## 7. What else happens when it runs

What one operation sets off: in-app messages, email, push, balance or billing
changes, permission changes, audit records, data synchronization, external calls.

Recipients and message contents are runtime values and are `unavailable`; the call
site and its channel are `fact`. Say which is which, rather than implying the report
knows who gets told.

## 8. What happens when things go wrong

Work the business-agnostic failure modes through the hypothesize–search–decide loop:
empty input, invalid input, double submission, concurrent modification, permission
changed mid-flow, record already deleted, partial success, oversized data, amount
precision, and date or time-zone boundaries.

For each: what the code does, what the user is told, what state the data is left in,
and whether it can be retried. All three verdicts are reportable — a search that
found no guard, on a kind with rows, is an evidenced absence, and it says which rows
were searched.

Network interruption, request timeout and external-service failure are answerable
only where the code declares handling for them. Where it does not, that is
`unavailable` — never "unhandled".

## 9. Configuration and switches

Which configuration affects this capability, its default, whether behaviour differs
by environment or customer, what a switch covers, and what the code does when it is
off.

## 10. What is wrong with it, and what a change would touch

Every entry rests on this capability contradicting itself or lacking something.
**MUST NOT** cite external best practice. Format and priority: `writing-rules.md`.

Under lead-ins:

* **Findings that resolve to an exact location** `fact` + `inferred`
* **Rules that appear to be missing** `verified` — every checklist item that ended
  `searched, not found`, with the rows searched
* **Still to confirm** `unavailable`
* **What a change here would touch** — which entry points, records, scheduled work
  and other capabilities read or write what this one does. A reachability statement
  from the base, marked `fact`. It says what is connected, not what would break.

## 11. Glossary

Three columns, per `writing-rules.md`, limited to the terms this report uses.

## 12. Coverage and what this report does not answer

Under lead-ins: **what was read** for this capability and how completely, each figure
with its denominator; **which tests exercise it**, and which of its journeys no test
covers; **what the analyser cannot see**.

Then the exclusion table: response times and data volumes, production configuration,
actual usage, retention and compliance requirements, ownership — and every checklist
item that ended `cannot be determined here`, each with its reason.

---

## Appendix: acceptance criteria (pipeline gate; not part of the report)

* Chapter 1 survives its own test, and states the resolved boundary with the ids it
  comprises and what was excluded.
* Chapter 1 lists actions a person can take, not entry points.
* Chapter 2's steps trace to flow evidence, not to entry-point names.
* Chapter 5 states the declared-versus-inline limit under its own lead-in.
* Every chapter has bolded lead-ins and closes with its synthesis.
* Every checklist item appears with a verdict, and every non-empty verdict cites ids
  that exist in the base.
* At least one finding came from `open` and is not a pre-computed
  `structural-finding` row.
* Every coverage figure carries its denominator.
