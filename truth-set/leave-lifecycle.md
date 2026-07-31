# WCP-V2 Leave — Lifecycle (detailed)

The leave feature end-to-end, from static source. Paths are under
`wcp-service-v2/internal/handlers/leave/` at SHA `7db2ee8d` unless prefixed with a
root. Resolution tags: **[obs]** observed, **[inf]** inferred, **[unr]** unresolved,
**[absent]** proven-absent.

---

## 1. Entry points

Backend routes (`router.go`, handler group `/v2/leaves`), matched 1:1 by the UI
client `wcp-ui/src/pages/leave/leave-service.ts`:

| Verb + path | Handler | Purpose |
|---|---|---|
| `POST /v2/leaves` | `Creation` (`router.go:30`) | apply for leave |
| `GET /v2/leaves/{id}` | `Demand` (`router.go:48`) | request detail |
| `POST /v2/leaves/{id}` | `Approve` (`router.go:66`) | approve current step |
| `PUT /v2/leaves/{id}` | `Reject` (`router.go:89`) | reject |
| `DELETE /v2/leaves/{id}` | `Deletion` (`router.go:217`) | cancel a *pending* request (own) |
| `POST /v2/leaves/{id}/application` | `DeletionApplication` (`router.go:192`) | request cancel of an *approved* leave |
| `GET /v2/leaves` | `Pagination` (`router.go:140`) | admin/manager list |
| `GET /v2/leaves/me` | `OwnPagination` (`router.go:165`) | own list |
| `GET /v2/leaves/export` | `Export` (`router.go:239`) | xlsx export |
| `GET /v2/leaves/apply-prompt` | `ApplyLeavePrompt` (`router.go:255`) | same-day/prenatal warnings before apply |
| `GET /v2/leaves/{id}/approve-prompt` | `ApproveLeavePrompt` (`router.go:247`) | context shown to approver |
| `GET /v2/leaves/remain-fully-paid-sick` | `GetUserRemainFullySickLeave` (`router.go:263`) | remaining sick balance |

Adjacent (same feature, different handler): `GET /v2/holidays/self` (balances),
`GET /v2/support/calculation/auto` (hour calc), `PUT /v2/holidayhour/{id}`
(HR/admin balance edit, `leaveHistory`).

All require `Authorization: Bearer jwt` (`router.go` swagger annotations; every
service method opens with a `NoSuchKeyInContext()` guard on the JWT claims).

---

## 2. Vocabulary (`constant/leave.go`)

**Leave types** (`LvHldyTypeC`): `PTO=1, BTO=2, UTO=3, Special=4, Sick=5,
Maternity=6, Paternity=7, Marriage=8, Funeral=9, Prenatal=10` (`:52-62`). The five
**sensitive types** {Maternity, Paternity, Marriage, Funeral, Prenatal} get an extra
HR step; PTO/Special are the only **cross-year** types.

**Categories** (`LvCatgC`, `:28-34`): `Auto=1` (hour-by-hour calc), `Regular=2`
(fixed hours/day), `Cancel=3`.

**Leave status** (`LvStatusC`, `:96-105`):

| # | const | display |
|---|---|---|
| 1 | `LvWaitingL1ApproveC` | Waiting L1 Approve |
| 2 | `LvWaitingL2ApproveC` | Waiting L2 Approve |
| 3 | `LvWaitingL3ApproveC` | Waiting L3 Approve |
| 4 | `LvApprovedC` | Approved |
| 5 | `LvRejectedC` | Rejected |
| 6 | `LvCompletedC` | Completed |
| 7 | `LvCancelledC` | Cancelled |
| 8 | `LvWaitingHRApproveC` | Waiting HR Approve |
| 9 | `LvWaitingLeadCancelC` | Waiting For Cancel |

**Approval-record status** (`LvAprvStatusC`, `:198-204`, zero-based): `Rejected=0,
Approved=1, Cancelled=2, WaitingApprove=3, SubmitCancelApplication=4`.

**Approval flow levels** (`:166-177`): `L1=1, L2=2, L3=3, HR=4`; flow-name strings
`"l1","l2","l3","HR","Lead Cancel"` written into `wcp_approve.approve_flow`.

---

## 3. State machine

Overall-leave `status` transitions (all `[obs]` unless noted):

```
                          ┌─ sensitive type ─→ (8) Waiting HR
   CREATE ────────────────┤
                          └─ else ───────────→ (1) Waiting L1   [or (2) if applicant is own L1 leader]

   (8) Waiting HR  ──HR approve──→ (1) Waiting L1   [or (2) if applicant == L1 manager]   service.go:460-465
   (1) Waiting L1  ──approve, hours>16──→ (2) Waiting L2                                    service.go:510-516
   (1) Waiting L1  ──approve, hours≤16──→ (4) Approved                                      service.go:606-611
   (2) Waiting L2  ──approve, hours>40──→ (3) Waiting L3                                    service.go:557-563
   (2) Waiting L2  ──approve, hours≤40──→ (4) Approved                                      service.go:606-611
   (3) Waiting L3  ──approve──────────→ (4) Approved                                        service.go:606-611
   (4) Approved   ──cron: end_date passed──→ (6) Completed                                  cron.go:41-55 (syncLvCompleted)

   (1|2|3|8) ──reject──→ (5) Rejected            [restores hours]                           service.go:889-897 → brdg_impl.go:823-828
   (1|2|3|8) ──own Deletion──→ (7) Cancelled      [restores hours]                          service.go:1372-1387 → brdg_impl.go:761
   (4|6) ──DeletionApplication──→ (9) Waiting For Cancel  [NO balance change]               service.go:1264-1314
   (9) ──lead approve──→ (7) Cancelled            [restores hours]                          service.go:424-456
   (9) ──lead reject───→ (4) Approved             [NO change]                               service.go:848-862
```

- **Escalation is driven by leave hours, not by org depth.** L1→L2 needs `hours>16`,
  L2→L3 needs `hours>40`; below the threshold the current level is final `[obs
  service.go:510,557,606]`. This is a distinct rule from the *chain-construction*
  logic at creation time (§4), which is org/role based — the two coexist `[obs]`.
- **One rejection terminates** the whole request → `(5) Rejected`; remaining levels
  were never created (records are created only on the approve path) `[obs
  service.go:889-897]`.
- **`(4) Approved → (6) Completed`**: written by the Go cron `syncLvCompleted`, which
  updates Approved leaves to Completed once `end_date` has passed
  (`third_party/cron/cron.go:41-55`), registered at service startup
  (`cron.go:19`; `wcp-service-v2/init/initialization.go:71`) `[obs]`. Whether the cron
  actually runs in production is not confirmable statically. (A JS `markLeaveDone` cron
  also existed but is disabled — `wcp-service/common/scheduleService.js:162`.)

---

## 4. Creation (`Creation`, `service.go:56`)

**Dispatch — Bridge pattern.** `service.go:117-127` builds
`brdgDirector{AbstType: Category, ImplType: HolidayType}` (`brdg_director.go`), which
selects an *Abstraction* by category (`AbstAuto` / `AbstRegular` / `AbstCancel`,
`brdg_impl.go:9`) and an *Implementation* by holiday type (`brdg_impl.go:15`), then
`abst.Apply()` computes the off-hours arrangement and calls `Impl.Consume()`. Unknown
category → `"Unknown abstranction type."` (sic); unknown type → `"Unknown
implementation type."` `[obs brdg_director.go:42,47]`.

**Initial status** (`saveLeaveRelated`, `brdg_impl.go:129-174`):
- sensitive type → HR looked up by nation config; if HR == applicant, collapse to
  `(1)`/`(2)`, else `(8) Waiting HR` `[obs :159-166]`.
- else → `(2)` if applicant is their own project leader, else `(1)` `[obs :168-173]`.
- These may be overwritten in the same transaction if `GenAprvRecord` finds
  self-approval short-circuits (§5).

**Balance is decremented at CREATE, not at approval.** For each consumed segment,
`holiday.<Type>Token += consumption` and `tx.Save(holiday)` on `wcp_holiday_hour`,
inside the same transaction as the leave insert `[obs brdg_impl.go:258-292]`. This is
a load-bearing, non-obvious fact — a pending leave has already spent balance.

**Rows written on create** `[obs]`:
- `wcp_leave` — one row (`brdg_impl.go:117-176`).
- `wcp_leave_detail` — one row per consumed day/segment (`brdg_impl.go:246-288`).
- `wcp_approve` — the approval chain (§5); the current pending row has `Status=nil`.
- `wcp_upload_file` — one row per attachment (`brdg_impl.go:180-193`).
- `wcp_holiday_hour` — mutated in place (token), **no** new row; **no** change-log row
  on create `[absent — the only change-log writer runs on withdrawal, brdg_impl.go:617-636]`.

**Hour calculation** (`support/service.go`): `CalculationAuto` (`:415`) walks
day-by-day (first/last partial days computed from clock times minus a noon lunch
hour; middle days flat 8h; holiday-calendar days skipped for PTO/BTO/UTO/Special
only). `CalculationRegular` (`:656`) repeats a fixed hours-per-day. Balance cap
(`maxAvailableHoliday`, `brdg_abst.go:88`) checks `Type - TypeToken` within a
nation-config expiration window; Sick/UTO/Maternity/Paternity/Marriage/Funeral/Prenatal
are **not** balance-capped at creation (`IgnoreMap`, `brdg_abst.go:25-33`) `[obs]`.

---

## 5. Approval routing (`approvement.go`)

**Chain of Responsibility**, constructed by holiday type in `brdg_impl.go`:
- PTO / Special (cross-year, `mixConsume`): `Level1 → Level2 → Level3`, no HR
  `[obs brdg_impl.go:370-374]`.
- sensitive types (`consumeCurtHoliday`): `HrApprover → Level1 → Level2 → Level3`
  `[obs :473-479]`.
- all others: `Level1 → Level2 → Level3` `[obs :488-492]`.

Max chain = **HR → L1 (project leader) → L2 → L3**. Each node, at creation, **skips
itself if the assigned approver is the applicant**, auto-approving and cascading; if
no next-level manager exists it jumps the whole leave straight to `(4) Approved`
`[obs approvement.go:90-92,138-156]`. Managers are resolved from
`wcp_project_manager` rows scoped by project+level (`queryMangerByLevel`); a missing
manager at an escalation target errors `"Specific manager of a level is not found."`
`[obs approvement.go:351-353]`.

> **[obs] Confirmed level mismatch:** `Level3`'s record creation queries the **level-2**
> manager and writes that person as the **L3** `ApproverID` (`approvement.go:281`), while
> the later notification queries the *real* L3 — so the approval record can be assigned to
> L2 but the notification sent to L3. `Level2`'s "no L3 configured" branch likewise
> re-queries level **2** (`approvement.go:221`). The code defect is in-repo; the trigger
> is conditional on project-manager configuration. See `leave-risks.md R7`.

**Recipient assembly is a separate Decorator chain** (`dcrt_recipient.go`):
`BaseEmpty → HRs → Approvers → ProjMembers → SiteManager`, each stage appending a
recipient set and de-duplicating. It builds notification address lists only; it is
**not** part of the approval decision `[obs]`.

**Permissions on approve/reject** (identical block `service.go:369-399, 817-846`):
Admin **or** HR may always act; otherwise the caller must be `isProjMng`
**and** exactly the `ApproverID` recorded on the current pending step — role alone is
insufficient. Otherwise `Forbidden()`. Acting on an already-decided step →
`"Already approved/cancelled."` `[obs]`.

> **[obs] Asymmetries worth recording** (dev-report / technical-fragility facet):
> (a) the applicant self-skip exists at chain creation and at HR→L1, but **not** at
> the hours-based L1→L2 / L2→L3 escalations (`service.go:510-604`) — an applicant can
> become their own L2/L3 approver. (b) `queryLeaveEssInfo` pulls `project_id` from
> *every* `wcp_project_manager` row, not the caller's managed projects
> (`service.go:330-353`) — the real gate is the later `ApproverID` id-match.

---

## 6. Cancellation (two distinct branches)

**(a) Cancel a pending request** — `Deletion`, `DELETE /v2/leaves/{id}`:
owner only (`service.go:1362`), status must be `1/2/3/8` else `"This leave request is
not in the progress of cancel."` (`:1366`). Routes through
`AbstCancel → Impl.Cancel` → `generalCancellation`/`crossCancellation`
(`brdg_impl.go:731,839`): restores hours (`withdrawHours`, refuses to go negative),
appends a Cancelled `wcp_approve` row, sets `(7) Cancelled`, notifies. `[obs]`

**(b) Request cancel of an approved leave** — `DeletionApplication`,
`POST /v2/leaves/{id}/application`: owner only, status must be `Approved(4)` or
`Completed(6)` (`service.go:1264`). **No balance change yet** — it only writes two
`wcp_approve` rows (`"Submit Cancel Request"` by the applicant, and a `"Lead Cancel"`
row for the project leader — rerouted to `"Site manager Cancel"` if the applicant *is*
their own leader) and re-parks the leave at `(9) Waiting For Cancel` `[obs
:1277-1314]`. The template literally tells the approver "the hours will be refunded to
the applicant" if approved (`templates/leave/leave_cancellation_applied.html:3`).
Resolution: lead **approve** → `(7) Cancelled` + restore (`service.go:424-456`); lead
**reject** → back to `(4) Approved`, no restore (`service.go:848-862`).

---

## 7. Notifications — events and exact recipients

Leave emails render via **`html/template`** (`handlers/notification/parse.go:5`,
`wcpNtf.ParseTemplate`) — user fields (`message_to_team` etc.) **are escaped**. (Only
the separate Update-plan path uses `text/template`.) Email is SES-shaped input delivered
over SMTP (`email-smtp.us-east-1.amazonaws.com`) via an **in-process** worker-pool channel
(10 workers); **send failures are logged and dropped, no retry** `[obs
third_party/ses/ses.go:26-40,33-36]`.

**Email and mobile push are separate recipient sets** — do not conflate them.

| Event | Email recipients | Mobile push | Template |
|---|---|---|---|
| **Applied** / forward-to-next | the single next approver (`notification.go:226-232, 636-642`) | next approver **+ applicant** (`:241-247`) | `leave_application_applied.html` |
| **Approve step** (applicant status-sync) | applicant (`:428-434`) | applicant | `leave_application_approved.html` |
| **Rejected** (and cancel-request reject) | To applicant, Cc **every approver** (`:790-800,861`) | applicant | `leave_application_rejected.html` |
| **Cancelled** (own pending self-cancel) | **every approver** (`:1282-1292`) | HRs-of-nation + applicant (`:1488-1508`) | `leave_application_cancelled.html` |
| **Cancellation-applied** (request to cancel approved) | single routed approver — leader, or site manager if applicant is own leader (`:1004-1020`) | HRs-of-nation + applicant (`:1094-1107`) | `leave_cancellation_applied.html` |
| **Cancellation-approved** | **HRs of nation + every approver + every member of every active project the applicant belongs to + every site manager + applicant** (`:1378-1417`, batched 50) | **applicant only** | `leave_cancellation_approved.html` |
| **Broadcast** (fires on a full approval via the `Approve` handler — **not** the creation-time self-approval collapse) | same wide union as cancellation-approved (`:1646-1675`); body = `Leave.MessageToTeam` | all those project members + applicant (`:1730-1740`) | `leave_broadcast.html` |
| **Update-plan** (leader capacity reminder) — only when `hours>40 && office∈{1,2} && endDate > first-day-of-current-month` (`service.go:700-722`) | the project leader (`:1789`) | — | literal `"leave_update_plan.html"` (bypasses the constant table, uses `text/template`) |

> **Highest-risk truth items.** The *Broadcast* and *Cancellation-approved* **email**
> fan-outs are a **union of whole groups**, not a single recipient — recording them as
> "notifies the manager" would be the classic narrowing error. The mobile set differs from
> the email set for most events; keep both intact and distinct in any report.

---

## 8. Data model

- `wcp_leave` — the request. Columns from `wcp-service/migrations/20200310022009-create-wcp-leave.js`
  (+ ALTERs: `is_send_mail`, `comments`, `category`, `uto_token` region): `id, user_id,
  holiday_type, project_id, category, start_date, end_date, hours, message_to_leader,
  message_to_team, cancel_reason, status, comments, ...`. `[obs]`
- `wcp_leave_detail` — one row per consumed day: `leave_id, date, hours, head, tail,
  holiday_source (year)`. `[obs]`
- `wcp_approve` — the approval trail: `leave_id, approver_id, approve_flow
  ("l1"/"l2"/"l3"/"HR"/"Lead Cancel"/...), description, status (nil=pending)`. `[obs]`
- `wcp_holiday_hour` — per-user/per-year balance, mutated by `<Type>Token` running
  totals; `wcp_holiday_hour_change_log` records manual HR edits and system trims
  (`UpdatorId=0` → rendered "the System-automated"). `[obs]`
- `wcp_upload_file` — attachments, `owner_id=leave.id`. `[obs]`
- **Schema ownership:** all migrations are in **`wcp-service`** (JS); the Go service
  has no migrations and shares the same tables. `[obs]`

---

## 9. External integrations

- **Email:** AWS SES via SMTP (`third_party/ses/ses.go`), in-process channel, no retry. `[obs]`
- **S3:** attachments (presigned GET, cached 2h) and xlsx exports (`PutObject`,
  `leave/export/Leave_*.xlsx`) — `third_party/s3/s3.go`, `service.go:1776-1782`. `[obs]`
- **No external queue/broker**; the only "queue" is the in-process Go channel. `[obs, scoped]`
- **No calls to other services** (wcp-auth, review service) from the leave package. `[obs, scoped — absence within files read]`

---

## 10. History / audit

`leaveHistory` tracks **holiday-hour balances**, not a per-application audit trail
`[obs]`. The application-state trail lives only as `wcp_approve` rows on the leave.
`HolidayHourChangeLog` is written on manual HR/admin balance edits and on the LatAm
PTO over-cap trim during withdrawal. A block that would log funeral/marriage/paternity
auto-clears is **fully commented out** `[absent — service.go:615-675]` — report as
*not happening*, not as a feature.

---

## 11. Notable technical-fragility observations (dev-report facet)

All `[obs]` unless tagged. These are candidate developer-report facts and good
resolution-vocabulary examples:

- SES send errors logged and dropped, no retry / no dead-letter (`ses.go:33-36`).
- `ParseTemplate` error discarded at one call site (`leaveHistory/tasks.go:109`).
- Update-plan template name hardcoded, bypassing the `LvTemlateName` constant table (and
  it renders with `text/template`, single internal recipient).
- `withdrawHours` negative-balance guard exists for every type **except** `Special`
  (`brdg_impl.go:551-552`).
- **Approver-level mismatch** `[obs]`: `Level3` record-creation reads the level-2 manager
  and writes it as the L3 `ApproverID` (`approvement.go:281`) while notification queries
  the real L3; `Level2`'s "no L3" branch re-queries level 2 (`approvement.go:221`).
- Hours-based escalation lacks the applicant self-skip that chain-creation has `[obs]`.
- Handler-package `Leave`/`LeaveDetail` structs duplicate `internal/model/*`; which set
  GORM binds at runtime for writes is not fully traced `[inf]`.
- **No row locking** (`FOR UPDATE`/`clause.Locking`) anywhere in the approve/reject/cancel
  path; the only concurrency guard is `lastAprv.Status != nil` inside the transaction `[obs]`.
- Same-day overlap has no hard creation block, **and** the pre-apply duplicate prompt is
  broken — `ApplyLeavePrompt` queries the repeats but never returns them, so
  `same_day_leaves` is always empty (`service.go:1877`) `[obs]`.

See `leave-risks.md` for the prioritized risk assessment built on these.
