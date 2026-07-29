# Say what is wrong with it

What a reader should know before trusting this system — at the level of the whole project. Problems belonging to one capability are covered in that capability's own document and do not belong here.

Aim for depth: a reader should come away knowing the several real risks in this system and why each matters, not one headline. Where the data supports five distinct project-level problems, write five — each as its own short paragraph with a `###` sub-heading naming it in plain words.

## What you have

- `structural-findings` — architecture-level findings: a table two services both write, a boundary not held, something true across parts.
- `data-ownership` — the shared and cross-boundary tables directly. A table `written-by-several` services, or `read-across-a-boundary`, is a concrete changeability risk you can describe: the rule guarding it lives in two places, or a storage change reaches a reader with no interface between.
- `reliability` — per service: error-handling, transactions, and *discarded errors* (fire-and-forget work whose failure nothing records). A service writing data with no transaction boundaries, or a cluster of discarded errors, is a real operational risk.
- `feature-findings` — the notable findings from individual capabilities. Where the *same* problem recurs across many capabilities (e.g. many capabilities each have endpoints nothing calls, or rules written in bare numbers), lift it to a project-level pattern here — that generalisation is exactly what an overview should add.
- `signals` — measures of the analysis. Read them for what they imply ("no two services call each other in a cycle" is a good property worth stating) but never report a measurement as a defect.

## How to weigh it

Draw across all of these. The strongest project-level findings usually combine sources: two services writing the same tables (`data-ownership`) *and* the rules on those tables differing (a `feature-finding`) is one finding — a genuine contradiction — told with both pieces of evidence. Prefer a few well-evidenced, consequential findings over a long thin list, but do not stop at one when the data holds more.

## How to say it

In terms a reader can act on, not in the words the analysis used internally.

Not: *"unguarded-writes, severity: concern, 3 occurrences."*
Instead: *"Two parts of the system both write the same records, and neither checks what the other did — so the same request handled by different parts can leave different results."*

Say what the consequence is for someone using or running the system. If you cannot say what a finding would mean to them, state the finding plainly rather than inventing a consequence.

## Order

Worst first, judged by what it would cost the people using the system — not by the severity label. A contradiction that produces different answers for the same request matters more than an unusual arrangement of code.

## Where there is nothing

If nothing project-level was found, say exactly that, and say what it does and does not mean: findings come from what the analysis was able to read, so nothing found is not the same as nothing wrong. Do not pad the section to look thorough.

## Rules

No severity labels, no finding identifiers, no file paths, no counts standing in for meaning. Translate a table name into what it holds. State nothing that is not in the data — where you are describing a consequence rather than a finding, the consequence must follow from what the finding actually says. End on the honest note: these are the problems the analysis could read, and a check written somewhere it could not follow would not appear here.

## How this answer is used

Your reply becomes the section "What is wrong with it" of the overview. Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 850 words.
