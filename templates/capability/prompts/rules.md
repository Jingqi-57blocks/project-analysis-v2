# Put the rules into words

The rules this capability enforces, said so a person can judge them. On many projects this is the most useful section in the document.

## What you have

`feature-rules:$capability` — each rule with:

- `statement` — the rule in words, with values named where the project names them
- `text` — the comparison exactly as the code writes it
- `guarded` — `rejects` if failing it stops the request, `continues` if the work carries on, null where it guards nothing
- `meanings` and `valueSetName` — what the value stands for, where the project declares a name for it

## How to write it

Group rules about the same thing and say what they add up to: *"A request is rejected if it is for more than 40 hours, or if the balance left is smaller than what was asked for."*

Say what failing a rule does. "Rejected" and "recorded anyway" are different systems, and `guarded` tells you which.

Where a value has a name in the project — a status of 4 meaning approved — use the name and give the number once in brackets. Where it has no name, say the number stands unexplained; do not guess what it means.

## Lead with disagreement

If two rules about the same thing set different limits — one rejecting over 16 hours and another over 40 — that is the single most valuable thing here. Lead with it, quote both, say where each applies, and say plainly that which one governs depends on the path taken. Do not resolve it; the analysis cannot say which is intended.

## Rules

No file paths, no line numbers, no code fragments except where quoting the comparison itself makes the point clearer than describing it.

Where there are few rules and they are simple, say so in a sentence or two and stop.
