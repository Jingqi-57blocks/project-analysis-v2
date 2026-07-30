# Decisions, measured

What the logic reader finds when it reads `if/else` chains and `switch`
statements as trees rather than as separate comparisons. Measured 2026-07-29.

| Target | Decisions | switch | if-chain | Branches | Named subject | Branches with nesting | Truncated |
|---|---:|---:|---:|---:|---:|---:|---:|
| WCP-V2 | 983 | 192 | 791 | 2,680 | 333 | 467 | 0 |
| angels-pizza | 258 | 21 | 237 | 691 | 21 | 93 | 0 |

## How to read these

**Decisions, not comparisons.** WCP-V2 records 1,957 conditions and 983
decisions. Those are different facts about the same code: a condition is one
comparison against a value, a decision is the question those comparisons
answer together. Both are kept — a guard outside any branch is still a rule.

**A named subject** means every branch tests the same thing, so the decision
can be titled: "what happens for each leave type". Where branches test
different things there is no subject, and 650 of WCP's 983 are that shape —
sequential guards rather than one question. Saying so is better than naming
the first branch's subject and implying the rest are about it.

**Nesting is common.** 467 of WCP's 2,680 branches contain a decision of their
own, which is where the rule a reader actually needs usually lives — `if type
== PTO { if hours > 40 { reject } }`.

**Nothing truncated** on either target, at a bound of 6 levels and 32
branches. The bound exists for machine-generated code; neither of these is.

## What it costs

Reading 400 WCP Go files — 102,224 lines — takes **1.6 s**, or 15.5 µs per
line, parsing included. Against a whole-project analyze of roughly 13 s that is
affordable, and it happens once when the knowledge base is built, never on
export.

## What a branch does not record

Its effects. Tables and calls have readers of their own with their own
locations, so a branch records the lines it spans and the effects are joined
from those readers afterwards. Detecting them again here would be a second
opinion that can disagree with the first.

## The gap this leaves

A single `if` with no `else` is not recorded as a decision — it is a guard,
and the condition records already state it with its subject, its value and
whether it rejects. Only branching produces a tree.
