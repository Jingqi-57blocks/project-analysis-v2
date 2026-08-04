# Reading the knowledge base

You are given one SQLite database holding everything a previous analysis learned
about a codebase. It is the whole of what is knowable here. You **MUST NOT** read
the analysed project's source — a gap in this database is reported as a gap, not
as a reason to go looking.

Open it read-only. Never write to it:

```
sqlite3 -readonly <kbPath> "select kind, count(*) from derived_records group by 1 order by 2 desc"
```

**Query, do not scan.** Aggregate in SQL and read back the answer, not the rows. A
`count(*)` costs one line of output; pulling every row to count them yourself costs
thousands, and each one stays in your context for the rest of the run. This is the
largest single thing you control about what the run costs.

`payload` is JSON everywhere. Read into it rather than returning whole documents:

```sql
select json_extract(payload, '$.name'), count(*)
  from structural_records where kind = 'entity' group by 1;
```

## The tables

| Table | Identity column | What it holds |
| -- | -- | -- |
| `derived_records` | `record_key` | Conclusions the engine already computed, plus the coverage ledger |
| `structural_records` | `record_key` | Structure read from source: symbols, routes, entities, call edges, guards, data accesses |
| `behavior_facts` | `fact_id` | Behaviour over that structure: rules, validations, states, transitions, value sets |
| `evidence_items` | `item_key` | Prose and literals lifted from the files themselves |
| `files` | — | Every file, its size, and whether it was analysed |
| `source_roots` | — | Each root's name, VCS, branch, `commit_sha` and `dirty` flag |

`evidence_items` is where a project's own words live — `kind` is one of
`readme-section`, `project-title`, `doc-comment`, `ui-label`, `config-key`,
`test-name`, `source-excerpt`. Use it to quote the project's self-description
instead of inventing one, to find deprecation and unfinished-work notes, to name
things the way the interface names them, and to pull a `source-excerpt` by path and
line range when a finding needs the surrounding code to be sure:

```sql
select rel_path, start_line, substr(text, 1, 400) from evidence_items
 where rel_path = ? and start_line between ? and ?;
```

`source_roots` and `files` answer the coverage chapter: which revision each root was
read at, whether it carried uncommitted changes, how many files were analysed and
how many were not, and why.

## Two traps

**Thirteen kinds are served by more than one table, with different counts.** On one
reference snapshot `condition` was 1957 structurally against 5780 behaviourally,
`validation-rule` 330 against 1271, `business-rule` 1957 behaviourally against 1957
derived. A census that sums across tables double-counts. If you state a count for
such a kind you **MUST** say which table you counted, and two chapters counting the
same kind from different tables contradict each other for no reason a reader can
see.

**Some rows cannot be the subject of a conclusion.** A row of a line-anchored kind —
`auth-annotation`, `call-edge`, `condition`, `data-access`, `decision`,
`discarded-error`, `error-handling`, `guard`, `outbound-call`, `value-set` — has an
identity containing a file line, so it moves whenever lines shift above it. Cite
these as evidence freely; never make one the thing a conclusion is *about*.

## Pass one — the census

Establish the shape before writing a sentence. One aggregate query per layer, in
this order:

1. `run-context` — the snapshot, the roots, what was read.
2. `coverage-note` — the coverage ledger. Read it **before** writing any sentence
   about coverage; it holds the real numbers, so do not estimate them.
3. `health-signal` — computed coverage and reachability signals.
4. `structural-finding` — cross-cutting findings, each with its own evidence list.
   Already checked; use them directly.
5. `module`, `feature`, `feature-flow`, `trace`, `component` — the computed shape.
6. `source_roots`, `files` — the snapshot and read scope.
7. Raw structural, behavioural and evidence rows underneath any of the above.

Then resolve the report's subject, if the spec asks for one.

A run that never opened `structural-finding`, `health-signal` or `coverage-note` and
still filled in the chapters they feed has invented those chapters. That has
happened. Going derived-first is not a performance tip.

## Pass two — the investigation

The census tells you what exists. It does not find anything. **Every conclusion
worth reading came from stating a hypothesis and searching for it**, and a run that
only tabulates kinds produces a census with chapter headings.

Your spec carries the checklist. Each item is one loop:

```
state the rule or defect you expect      ->  search for it in SQL  ->  let the code decide
```

and each ends in exactly one of three verdicts, all of which are reportable:

| Verdict | When |
| -- | -- |
| hit | The search found it; cite the rows |
| searched, not found | The kind has rows and none matched; say which rows you searched |
| cannot be determined here | The kind is empty in this project; say so and move on |

The third verdict is what keeps the checklist honest on a project the checklist was
not written for. It is not a failure to report it.

Searches use predicates. `select kind, count(*) ... group by 1` is a census query;
`... where lower(json_extract(payload,'$.statement')) like '%...%'` is a search. A
run whose queries are all of the first kind has not investigated, and the audit
checks exactly that.

### One worked pattern

Finding a permission check that is written inconsistently across its uses needs a
comparison no single row shows. Extract the called predicate out of each guard's
test, group by it, and read the group for a member whose negation differs from its
peers:

```sql
select json_extract(payload,'$.payload.test')    as test,
       json_extract(payload,'$.evidence[0].provenance.source.relPath')   as path,
       json_extract(payload,'$.evidence[0].provenance.source.startLine') as line
  from behavior_facts
 where kind = 'guard'
   and json_extract(payload,'$.payload.test') like '%' || ? || '%'
 order by 1;
```

The odd one out is only visible side by side. Sites separated by a thousand lines in
two different files are adjacent here — that adjacency is the reason this database
exists, and finding it is not something a run that reads source could do.

## When the base cannot answer

A kind with no rows in scope is a fact about the project and **MUST** be reported as
one: say the kind is empty and what that means for the chapter. It is not licence
to fill the chapter from elsewhere.

If a mandatory chapter has nothing to stand on, stop and report that, rather than
producing prose that reads as though it were grounded.
