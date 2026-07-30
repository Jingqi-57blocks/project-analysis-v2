# Say what states a record moves through

A rebuild has to reproduce a record's lifecycle: the values a status can hold, and what has to be true before it changes. This section is what the code says about that.

## What you have

- `value-sets` — the named sets of values the code declares, with their members and where each set is declared. A status, state or stage set is the raw material here.
- `guards` — the checks that reject, each quoted in the message it rejects with. Many of these are preconditions on a change of state: "not in waiting approve status", "already cancelled", "has been billed and cannot be cancelled".

## What to write

**The value sets that are lifecycles.** For each, name the states in the order the code declares them, and say which record they belong to if the set's own name says so.

**What has to be true to move.** Read the guards for preconditions and group them by the record they constrain. A guard saying a record must be *approved* before it can be cancelled is a transition rule; quote the message and say what it forbids.

**Where a lifecycle is only partly visible.** If a set of states exists but no guard names any of them, say the states are declared and the transitions between them were not read. That is the honest half-answer, and it is more useful than a diagram that implies a sequence nobody verified.

## Rules

- **Do not draw a state machine the guards do not support.** A list of states plus a handful of rejection messages is not a transition graph. If you cannot say what moves a record from one named state to another, say so.
- Quote a guard's message verbatim when you cite it. It is the rule as the code states it — and quote it as the slice gives it, without completing a sentence that stops mid-phrase: a message built from a template reaches you as one run of its text, which may begin or end mid-phrase (`].date must be YYYY-MM-DD`), and finishing it would be your words presented as the code's.
- State names exactly as declared, including case and prefix.
- Never order states by plausibility. If the declaration order is all you have, say that is what you are reporting.
- Do not merge two sets that look similar. Two status sets with overlapping member names are two sets.

## How this answer is used

Your reply becomes the lifecycle section of a recovered specification. Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 600 words.
