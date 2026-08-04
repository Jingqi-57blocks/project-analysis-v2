# Reading the fact pack

You are given a **fact pack**: a SQLite database holding exactly the facts your
report may use, already cut to one scope and to the kinds your spec declares. You
cannot widen it, and you **MUST NOT** read the analysed project's source — the
pack is the whole of what is knowable here. If something you need is missing, say
it is unavailable and name the gap; do not go looking for it.

Query it with SQL:

```
sqlite3 -readonly <packDb> "select kind, count(*) from facts group by kind order by 2 desc"
```

**Use SQL, not file scans.** Aggregate in the query and read back the answer, not
the rows. A `count(*)` costs one line of output; pulling every row to count them
yourself costs thousands, and every one of them stays in your context for the rest
of the run. This is the single largest thing you control about how long the run
takes and what it costs.

## The tables

```sql
facts    (source, kind, key, payload, root_name, rel_path, start_line, subject_key)
subjects (type, ref, fact_key)
coverage (kind, source, in_snapshot, in_scope)
pack     (snapshot_identity, scope, module_id, kb_module_id, requires)
```

`facts.key` is the fact id. **Every claim you make cites the keys of the rows
supporting it**; a claim with no keys is invalid and the audit will reject it.

`payload` is JSON. SQLite reads into it directly, which is usually cheaper than
returning the whole document:

```sql
select json_extract(payload, '$.name'), count(*)
  from facts where kind = 'entity' group by 1;
```

`source` is the knowledge-base table a row came from. It matters because fourteen
kinds are served by **two** tables with different counts — `condition` is 1957
rows structurally against 5780 behaviourally on the reference snapshot,
`auth-annotation` 113 against 434. **If you state a count for such a kind you MUST
say which source you counted.** Two chapters counting the same kind from different
sources contradict each other, and no reader can see why.

## Read the derived layer first

Facts come from three sources, in two layers.

| `source` | Layer | What it holds |
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

**Before writing anything, walk every kind in `pack.requires`.** One query gives
you the shape:

```sql
select kind, source, count(*) from facts group by 1, 2 order by 3 desc;
```

A kind with rows you never opened will show in the audit as an unused kind, and a
chapter written without opening the kind that feeds it is the failure mode this
rule exists for.

## Two traps

**Some facts cannot be the subject of a claim.** A row of a line-anchored kind —
`call-edge`, `condition`, `guard`, `data-access`, `decision`, `error-handling`,
`outbound-call`, `discarded-error`, `auth-annotation`, `value-set` — has an
identity containing a file line, so it moves whenever lines shift above it. Cite
these as evidence freely; never make one the thing a claim is *about*. The
`subjects` table is what you use instead.

**Coverage has a denominator.** `coverage` gives `in_snapshot` and `in_scope` per
kind and source. Every coverage statement in the report carries both numbers.
"Some calls could not be resolved" is not acceptable; "18% (93/520) of call chains
terminated early" is.

## When the pack cannot answer

The pack may legitimately have no rows of a kind your spec lists. That is a fact
about the project, and it is reportable: say the kind is empty in this scope and
what that means for the chapter. It is not licence to fill the chapter from
elsewhere.

If a chapter your spec marks mandatory has nothing to stand on, generation should
already have been refused before you were called. If you find yourself about to
write a mandatory chapter with no supporting rows, stop and report it rather than
producing prose that reads as though it were grounded.
