# Reading the fact pack

You are given a **fact pack**, not the knowledge base. It has been cut to one
scope and to exactly the fact kinds your spec declares. You cannot widen it, and
you **MUST NOT** read the analysed project's source — the pack is the whole of
what is knowable here. If something you need is missing, say it is unavailable
and name the gap; do not go looking for it.

## What a pack contains

```
snapshotIdentity   which analysis run this came from
scope              "project", or the scope your spec serves
moduleId           the module requested, for a scoped pack
kbModuleId         the knowledge-base module it resolved to
requires           the fact kinds your spec declared
rows               the facts themselves
coverage           per kind and table: how many exist, how many are in scope
subjects           the things a claim may be about
```

Each row carries: `table`, `kind`, `key`, `payload`, `rootName`, `relPath`,
`startLine`, `subjectKey`. **`key` is the fact id.** Every claim you make cites
the keys of the rows supporting it; a claim with no keys is invalid and will be
rejected by the audit.

## Read the derived layer first

Facts come from three tables, in two layers.

| Table | Layer | What it holds |
| -- | -- | -- |
| `derived_records` | derived | Conclusions the engine already computed, plus the coverage ledger |
| `structural_records` | raw | Structure read from source: symbols, routes, entities, call edges, guards, data accesses |
| `behavior_facts` | raw | Behaviour over that structure: rules, validations, states, transitions, value sets, tests |

Work in this order:

1. `run-context` — the snapshot, the roots, what was read.
2. `coverage-note` — the coverage ledger. Read it **before** writing any sentence
   about coverage. It holds the real numbers; do not estimate them.
3. `health-signal` — computed coverage and reachability signals.
4. `structural-finding` — computed cross-cutting findings, each with its own
   evidence list. These are conclusions, already checked; use them directly.
5. `module`, `feature`, `feature-flow`, `trace` — the computed shape of the system.
6. Raw structural and behaviour rows — the evidence under any of the above.

In the trial, the run that fabricated never queried `structural-finding`,
`health-signal` or `coverage-note` at all, and still filled in every chapter they
feed. Going derived-first is not a performance tip; it is how you avoid inventing
what has already been computed.

**Before writing anything, walk every kind in `requires`.** A kind with rows you
never opened will show up in the audit as an unused kind, and a chapter written
without opening the kind that feeds it is the failure mode this rule exists for.

## Three traps

**A kind can come from two tables, with different counts.** `condition`,
`data-access`, `decision`, `guard`, `auth-annotation` and nine others are served
by both `structural_records` and `behavior_facts`. On the reference snapshot
`condition` is 1957 rows structural against 5780 behavioural. If you state a
count for such a kind you **MUST** say which table you counted. Two chapters
counting the same kind from different tables contradict each other, and no reader
can see why.

**Some facts cannot be the subject of a claim.** A row of a line-anchored kind —
`call-edge`, `condition`, `guard`, `data-access`, `decision`, `error-handling`,
`outbound-call`, `discarded-error`, `auth-annotation`, `value-set` — has an
identity containing a file line, so it moves whenever lines shift above it. Cite
these as evidence freely; never make one the thing a claim is *about*. The
`subjects` list in the pack is what you may use instead.

**Coverage has a denominator.** `coverage[]` gives `inSnapshot` and `inScope` per
kind and table. Every coverage statement in the report carries both numbers.
"Some calls could not be resolved" is not acceptable; "18% (93/520) of call
chains terminated early" is.

## When the pack cannot answer

The pack may legitimately have no rows of a kind your spec lists. That is a fact
about the project, and it is reportable: say the kind is empty in this scope and
what that means for the chapter. It is not licence to fill the chapter from
elsewhere.

If a chapter your spec marks mandatory has nothing to stand on, generation should
already have been refused before you were called. If you find yourself about to
write a mandatory chapter with no supporting rows, stop and report it rather than
producing prose that reads as though it were grounded.
