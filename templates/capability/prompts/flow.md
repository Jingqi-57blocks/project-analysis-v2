# Draw the logic as a flowchart a person can follow

A reader has just read what this capability is and what happens when it is used. This section shows the *decision logic* as a Mermaid flowchart: what the code checks, in what order, and what each answer leads to — so someone who will never read the code can see how a request is actually handled.

## What you are drawing from

- `feature-decisions:$capability` — the `if`/`switch` trees the code makes: the subject each one tests, its branches, the real condition on each branch, and whether taking it stops the request or carries on. Nested decisions are inside their branch.
- `feature-rules:$capability` — the conditions the code guards with, each carrying its `fullTest` (the whole test the comparison belongs to, e.g. `lv.Hours > 16 && flow == L1`), whether it `rejects`, and its `enclosingFunction`.
- `feature-flows:$capability` — the request paths, so you know where a check sits in the sequence (auth → validate → decide → persist).

These are the facts. The flowchart is your synthesis of them into something readable — you may reorder checks into the sequence the journey follows and translate a raw condition into plain words, but **every node must trace to a decision or rule in the data**. Do not invent a branch, a threshold, or an approval step the data does not contain.

## How to draw it

Write one or more ```mermaid `flowchart TD` blocks. Prefer **one main flow** for the capability's primary action (the thing it is mostly for), and a small separate diagram only where a second action has genuinely different logic.

Make the labels say what is happening in the domain's terms:

- A decision node is a question: *"What type of leave?"*, *"More than 16 hours?"*
- A branch label is the answer: *"BTO"*, *"more than 40h"*, *"otherwise"*.
- An outcome node says what happens: *"Rejected — balance would go negative"*, *"Escalate to second approver"*, *"Recorded, awaiting L1"*.

Translate the code's own values using the value sets where they name them (`constant.PtoC` → "paid time off"; a raw `2` stays `2` if nothing names it, and you say the number is unexplained). Fold the same check made in many places into one node. Where a real threshold exists in the data — `> 16`, `> 40`, `== 8` — put the number in the label; that specificity is the point.

After each diagram, a short paragraph (2–4 sentences) in plain words: what the diagram shows, and the one or two things a reader should take from it.

## Honesty

- If a branch's consequence was not established in the data, say so in the node (*"handled — effect not established"*) rather than inventing one. A partly-known flow drawn honestly is worth more than a tidy invented one.
- If the decisions and rules are too thin to draw a meaningful flow (a capability that only reads and lists), say that in one sentence and draw nothing. An empty honest section is the right answer there.
- Do not show file names, function names, variable names, or table names in the diagram. The reader wants the logic, not the code.

## How this answer is used

Your reply becomes the section "The logic, drawn" of a generated report. Write the section body only — the ```mermaid blocks and their short explanations. No preamble, no repetition of the heading.

- `data.json` beside this file is everything you may draw from. A node with no basis in it is an invented fact.
- Headings no shallower than level 3 (`###`) if you use any.
