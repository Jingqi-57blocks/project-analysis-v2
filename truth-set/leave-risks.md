# WCP-V2 Leave — Risks & Problems (prioritized)

**Subjective engineering assessment**, grounded in the cited code. This is judgement,
not extracted fact — separated from the truth ledger on purpose. Priority is my call
on business/security/data impact × likelihood. Minor issues are excluded (listed at
the end so the omission is explicit). Paths under
`wcp-service-v2/internal/handlers/leave/` @ `7db2ee8d` unless a root is named.

Confidence tags: **[obs]** proven in code · **[inf]** strong reading, needs a runtime/fixture check.

> **Not report content.** The V1 dual-report content contract and PI-48 forbid subjective
> priority/severity ranking and remediation in the generated reports — their problem ledger
> is priority-neutral (`observed|inferred|unresolved` + confidence + impact + citation).
> This file's P1/P2 ordering is a **development-time judgement for us** (what to fix first).
> To feed the report grading, each item below maps to a neutral problem-ledger entry with a
> stable `problemId`; the ranking is dropped there.

> **Corrected 2026-07-31 after a source review against WCP-V2.** Two earlier P1s were
> removed as factually wrong: a broadcast HTML-injection risk (leave emails render via
> `html/template`, `handlers/notification/parse.go:5`, so fields are escaped) and a
> "`Completed` is a dead state" risk (a Go cron writes it — see the lifecycle doc). Do not
> reintroduce them.

---

## P1 — High

### R1. Self-approval is possible on hours-based escalation (segregation-of-duties bypass) **[obs]**
The applicant self-skip exists at chain construction and at the HR→L1 hop
(`service.go:462-464`), but there is **no self-skip on the L1→L2 (`hours>16`) or
L2→L3 (`hours>40`) escalations** (`service.go:510-604`). If the applicant is the L2 or
L3 manager of their own project, they are assigned as their own approver on a long
leave and can approve it themselves. Longer leaves (which is exactly when escalation
triggers) are the ones that escape the control.
**Impact:** an employee can self-approve their own >16h / >40h leave. Fix: apply the
same `applicant == approver` skip/deny at every escalation hop.

### R2. Balance is spent at creation and guarded by neither locks nor a complete floor **[obs] + [inf]**
Holiday balance is decremented **at creation** (`<Type>Token += consumption`,
`brdg_impl.go:258-292`), not at approval; it is only given back by the reject/cancel
withdrawal paths. Two amplifiers:
- **No row locking** on approve/reject/cancel (no `FOR UPDATE`/`clause.Locking` found).
  The sole guard against a double transition is `lastAprv.Status != nil` inside the
  transaction. Under the DB's default isolation two concurrent approvals/cancels can
  both read `Status == nil` and both proceed → double token mutation. **[inf — severity
  depends on the MySQL isolation level, which I did not confirm]**
- **Missing negative floor for Special leave**: `withdrawHours` refuses to push a token
  negative for every type **except `Special`** (`brdg_impl.go:551-552`).
**Impact:** money-equivalent balances can leak, double-restore, or go negative under
races or partially-failed transitions. Fix: pessimistic lock (or optimistic version)
on the leave row across the transition; add the Special floor; move deduction to
approval or make restoration idempotent.

---

## P2 — Medium

### R3. No hard block on duplicate same-day leave, and the pre-apply prompt is non-functional **[obs]**
Two problems: (a) none of the creation validations rejects an overlapping/duplicate
same-day request, and (b) the pre-apply warning meant to surface duplicates is broken —
`ApplyLeavePrompt` queries the repeat records but never appends them to the returned
`ret`, so `same_day_leaves` is **always empty** (`service.go:1877`), and the query only
looks at WaitingCancel/Approved/Completed, not normal pending states. (The
*approve*-side prompt does populate correctly.)
**Impact:** a user can file two leaves for the same day (double balance spend), and the
UI hint that should warn them shows nothing. Fix: enforce overlap detection server-side
at creation; fix the apply-prompt to actually return the records and cover pending states.

### R4. Cross-service schema coupling with no compile-time link **[obs]**
The Go leave service reads/writes `wcp_leave*` tables whose **migrations live entirely
in the JS service** (`wcp-service/migrations/`); Go v2 has no migrations of its own.
**Impact:** a JS-side migration (or a missed one) can break the Go service at runtime
with nothing catching it at build time — the two are coupled only by table shape and
convention. Fix: at minimum a shared schema contract/version check; ideally one owner.

### R5. Notifications are best-effort and non-durable **[obs]**
SES send failures are logged and dropped, no retry / no dead-letter
(`third_party/ses/ses.go:33-36`), and the send queue is an **in-process Go channel**
(`ses.go:26-40`), so pending emails are lost on process restart.
**Impact:** approval/broadcast emails can silently vanish (a partial broadcast, a
missed notice). Note the workflow does **not** depend on email alone — approvers also
get a mobile push and can see the pending item in their approval list — so a dropped
email degrades signal rather than fully stalling a leave. Fix: durable queue + retry/DLQ.

### R6. Authorization depends on a single id-match; the pre-fetch is effectively unscoped **[obs]**
`queryLeaveEssInfo` collects `project_id` from **every** `wcp_project_manager` row, not
the caller's managed projects (`service.go:330-353`); the only real gate is the later
`lastAprv.ApproverID == caller` check (`service.go:397`). Admin/HR can act on any leave
at any step by design.
**Impact:** defense-in-depth is thin — if the id-match check ever regresses, any project
manager could act on any leave. Fix: scope the fetch to the caller's projects too.

### R7. Confirmed approver-level mismatch in chain construction **[obs]**
Two concrete level mix-ups, not just a suspected one:
- `Level3`'s record creation queries the **level-2** manager and writes that person as
  the **L3** `ApproverID` (`approvement.go:281`), while the subsequent notification
  queries the *real* L3 — so the approval record can be assigned to the L2 manager but
  the notification sent to L3.
- `Level2`'s "no L3 configured" branch re-queries level **2** rather than level 3
  (`approvement.go:221`).
**Impact:** on the conditional paths that reach this code, the wrong person can be
recorded as (or notified as) the L3 approver. The code defect is confirmed; the exact
trigger is conditional on project manager configuration. Fix: read the correct level at
each node and align record `ApproverID` with the notified approver.

---

## Explicitly excluded as minor (not ignored — judged low-impact)
- Update-plan email uses `text/template` (no escaping) on its own path, but it has a
  single internal recipient (the project leader) — low impact. (The main leave emails,
  including the broadcast, use `html/template` and *are* escaped.)
- `ParseTemplate` error discarded at one call site (`leaveHistory/tasks.go:109`).
- `PutObject` returns a raw unwrapped error while siblings wrap (`s3.go:125`).
- `"Unknown abstranction type."` message typo (`brdg_director.go:47`).
- Update-plan template name hardcoded instead of via the constant table.
- `OwnLvStatusC2FMap` has no entry for status 9 (`constant/leave.go`).
- Duplicate `Leave` structs (handler-package vs `internal/model`) — a smell; which GORM
  binds at runtime is untraced **[inf]**, but no incorrect behavior was observed.

---

### Coverage boundary (what this assessment did NOT deep-read)
Balance **accrual/seeding** (how `wcp_holiday_hour` rows are created and expire),
list/pagination filter logic, and xlsx export rendering were only skimmed. Risks there
are not assessed — declared, not silently omitted.
