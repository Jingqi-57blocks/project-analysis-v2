# WCP-V2 Leave — Truth Ledger (draft v0.1)

Facet-tagged, evidence-anchored truth items. Read with `README.md` (frozen SHAs,
resolution vocabulary) and `leave-lifecycle.md` (the detail behind each item).

> **Corrected 2026-07-31** after a source review against WCP-V2. Fixed: `Completed(6)`
> is reachable (Go cron), the notification email-vs-mobile recipients, the update-plan
> condition, TR-01 self-approval exceptions, and the same-day prompt (it is broken, not a
> working advisory). Removed: the false "no-escape template" report item.

Paths under `wcp-service-v2/internal/handlers/leave/` @ `7db2ee8d` unless a root is
named. Columns: **id · facet · category · claim · evidence · resolution ·
expected-status**. `expected-status` is what a fresh analyzer run should report for
this item (`found` / or an explicit allowed `unresolved`/`absent`).

---

## Structure — facet M1

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-STRUCT-EP-01 | entry-point | `POST /v2/leaves` → `Creation` is the apply entry point | `router.go:30` | obs | found |
| T-STRUCT-EP-02 | entry-point | `POST /v2/leaves/{id}` → `Approve`; `PUT /v2/leaves/{id}` → `Reject` | `router.go:66,89` | obs | found |
| T-STRUCT-EP-03 | entry-point | `DELETE /v2/leaves/{id}` → `Deletion` (cancel pending); `POST /v2/leaves/{id}/application` → `DeletionApplication` (cancel approved) | `router.go:192,217` | obs | found |
| T-STRUCT-EP-04 | entry-point | list: `GET /v2/leaves` (`Pagination`), `GET /v2/leaves/me` (`OwnPagination`); export `GET /v2/leaves/export` | `router.go:140,165,239` | obs | found |
| T-STRUCT-EP-05 | entry-point | prompts: `GET /v2/leaves/apply-prompt`, `GET /v2/leaves/{id}/approve-prompt`; sick balance `GET /v2/leaves/remain-fully-paid-sick` | `router.go:247,255,263` | obs | found |
| T-STRUCT-UI-01 | call-edge | UI leave feature calls Go `/v2/*` (leaves, plus holiday, holiday-hour, calculation); **no static call to the legacy `/leaves*` API** found | `wcp-ui/.../leave-service.ts` (whole file) | obs | found |
| T-STRUCT-TBL-01 | db-table | tables: `wcp_leave`, `wcp_leave_detail`, `wcp_approve`, `wcp_holiday_hour`, `wcp_holiday_hour_change_log`, `wcp_upload_file` | `model/leave.go`; `constant/table.go` | obs | found |
| T-STRUCT-TBL-02 | db-ownership | leave schema/migrations live in **`wcp-service`** (JS); Go v2 has no migrations, shares the tables | `wcp-service/migrations/*leave*`; absence of a Go migrations dir | obs | found |
| T-STRUCT-JS-LEGACY | boundary | `wcp-service/routes/leave.js` exposes 11 real leave endpoints at `/leaves`, but **no static caller** exists in the 5 roots; superseded by Go `/v2`. NOT proven dead (external traffic not knowable statically) | `wcp-service/app.js:100`; whole-workspace grep | obs (routes) + **unresolved** (prod liveness) | found-as-legacy; liveness `unresolved` |
| T-STRUCT-JS-STILL | boundary | `wcp-service` is not dead: owns leave schema + `leaveService` used by a live cron (worklog reminder) & report exports | `wcp-service/services/notificationService.js:81` | obs | found |

## Behavior — states & transitions — facet M2

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-BEHAV-ST-01 | state-set | 9 leave statuses: WaitingL1(1) L2(2) L3(3) Approved(4) Rejected(5) Completed(6) Cancelled(7) WaitingHR(8) WaitingLeadCancel(9) | `constant/leave.go:96-105` | obs | found |
| T-BEHAV-ST-02 | state-set | approval-record statuses: Rejected(0) Approved(1) Cancelled(2) WaitingApprove(3) SubmitCancelApplication(4) | `constant/leave.go:198-204` | obs | found |
| T-BEHAV-TR-01 | transition | create → initial status: sensitive type → WaitingHR(8) unless the configured HR is the applicant; else → WaitingL1(1), or L2(2) if applicant is own leader. Self-approval collapse at chain build can advance further or straight to Approved(4) | `brdg_impl.go:129-173`; `approvement.go:90-92,138-156` | obs | found (with exceptions) |
| T-BEHAV-TR-02 | transition | HR approve → WaitingL1(1) [or L2(2) if applicant == L1 mgr] | `service.go:460-465` | obs | found |
| T-BEHAV-TR-03 | transition | L1 approve: hours>16 → WaitingL2(2), else → Approved(4) | `service.go:510-516,606-611` | obs | found |
| T-BEHAV-TR-04 | transition | L2 approve: hours>40 → WaitingL3(3), else → Approved(4) | `service.go:557-563,606-611` | obs | found |
| T-BEHAV-TR-05 | transition | L3 approve → Approved(4) | `service.go:606-611` | obs | found |
| T-BEHAV-TR-06 | transition | reject (any waiting) → Rejected(5); one rejection terminates; hours restored | `service.go:889-897`; `brdg_impl.go:823-828` | obs | found |
| T-BEHAV-TR-07 | transition | own `Deletion` (status 1/2/3/8) → Cancelled(7); hours restored | `service.go:1372-1387`; `brdg_impl.go:761` | obs | found |
| T-BEHAV-TR-08 | transition | `DeletionApplication` (status 4/6) → WaitingLeadCancel(9); **no balance change** | `service.go:1264-1314` | obs | found |
| T-BEHAV-TR-09 | transition | lead approves cancel (9) → Cancelled(7) + restore; lead rejects (9) → Approved(4), no change | `service.go:424-456,848-862` | obs | found |
| T-BEHAV-TR-10 | transition | escalation threshold is **leave hours** (>16, >40), not org depth | `service.go:510,557` | obs | found |
| T-BEHAV-TR-11 | transition | **Approved(4) → Completed(6)** is written by the Go cron `syncLvCompleted` when `end_date` has passed; registered at service startup. (Production execution needs runtime evidence; a JS `markLeaveDone` cron also existed but is disabled.) | `third_party/cron/cron.go:19,41-55`; `wcp-service-v2/init/initialization.go:71` | obs | found (reachable) |
| T-BEHAV-TR-12 | rule | overlapping/duplicate same-day leave is **not** hard-blocked at creation; the pre-apply duplicate prompt is broken (always returns empty) | `service.go:1877` | obs | found (see risks R3) |
| T-BEHAV-CONC-01 | concurrency | no row locking on approve/reject/cancel; guard is `Status != nil` only | grep: no `FOR UPDATE`/`Locking` in `handlers/leave` | obs | found (no lock) |

## Behavior — rules, permissions, validations — facet M2

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-BEHAV-PERM-01 | permission | approve/reject: Admin **or** HR always; else must be `isProjMng` **and** the exact `ApproverID` of the current pending step; else Forbidden | `service.go:369-399,817-846` | obs | found |
| T-BEHAV-PERM-02 | permission | cancel (both branches) is **owner-only** | `service.go:1362,1253-1260` | obs | found |
| T-BEHAV-RULE-01 | approval-routing | chain built by type: PTO/Special = L1→L2→L3; sensitive = HR→L1→L2→L3; others = L1→L2→L3 | `brdg_impl.go:370-374,473-479,488-492` | obs | found |
| T-BEHAV-RULE-02 | approval-routing | at creation, a node whose approver == applicant auto-approves & cascades; no next manager → jump to Approved(4) | `approvement.go:90-92,138-156` | obs | found |
| T-BEHAV-RULE-03 | balance | balance is decremented **at creation** (`<Type>Token += consumption`), not at approval | `brdg_impl.go:258-292` | obs | found |
| T-BEHAV-RULE-04 | balance | Sick/UTO/Maternity/Paternity/Marriage/Funeral/Prenatal are **not** balance-capped at creation (IgnoreMap) | `brdg_abst.go:25-33` | obs | found |
| T-BEHAV-VAL-01 | validation | attachment required for Sick/Maternity/Prenatal/Marriage → "Attachment is required." | `service.go:73-80` | obs | found |
| T-BEHAV-VAL-02 | validation | BTO forbidden during probation → "BTO cannot be taken during the probation period." | `service.go:112-114` | obs | found |
| T-BEHAV-VAL-03 | validation | BTO must be exactly 8h & single day; Prenatal 8h & single day | `brdg_impl.go:1018-1023,1166-1172` | obs | found |
| T-BEHAV-VAL-04 | validation | sick leave >1 work day requires a doctor's note | `brdg_abst.go:258-265` | obs | found |
| T-BEHAV-VAL-05 | validation | insufficient balance (capped types) → "Not enough holiday." | `brdg_abst.go:284,310,406,432` | obs | found |
| T-BEHAV-VAL-06 | validation | presale/EOR project blocks leave; project must exist | `service.go:63-71` | obs | found |
| T-BEHAV-VAL-LIST | validation | the creation validations enumerated in `leave-lifecycle.md §4` (project/attachment/probation/BTO-8h/prenatal/sick-note/balance/…) — each with a `file:line` there | `leave-lifecycle.md §4` | obs | found (list not yet independently pinned — see open items) |
| T-BEHAV-EXC-01 | exception | acting on a decided step → "Already approved/cancelled." | `service.go:394,842` | obs | found |
| T-BEHAV-EXC-02 | exception | cancel when status not cancelable → "This leave request is not in the progress of cancel." | `service.go:1366` | obs | found |

## Behavior — side effects & notifications — facet M2 (+M3 recipients)

Notification recipients differ by channel — **email and mobile push are separate sets.**

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-BEHAV-NOTIF-01 | notification | Applied / forward-to-next: **email** → the single next approver; **mobile** → next approver + applicant. tmpl `leave_application_applied` | `notification.go:226-232,241-247` | obs | found |
| T-BEHAV-NOTIF-02 | notification | Approve step (status sync): email + mobile → applicant. tmpl `leave_application_approved` | `notification.go:428-434` | obs | found |
| T-BEHAV-NOTIF-03 | notification | Rejected: **email** → To applicant, Cc every approver; **mobile** → applicant. tmpl `leave_application_rejected` | `notification.go:790-800,861` | obs | found |
| T-BEHAV-NOTIF-04 | notification | Cancelled (own pending): **email** → every approver; **mobile** → HRs-of-nation + applicant. tmpl `leave_application_cancelled` | `notification.go:1282-1292,1488-1508` | obs | found |
| T-BEHAV-NOTIF-05 | notification | **Broadcast** fires on a full approval **via the `Approve` handler** (not the creation-time self-approval collapse). **email** → HRs of nation + every approver + every member of every active project the applicant belongs to + site managers + applicant (body = `MessageToTeam`); **mobile** → all those project members + applicant. tmpl `leave_broadcast` | `service.go:677`; `notification.go:1646-1675,1730-1740` | obs | found — **email set is a union; keep it un-narrowed** |
| T-BEHAV-NOTIF-06 | notification | Cancellation-approved: **email** → same wide union as broadcast (batched 50); **mobile** → applicant only. tmpl `leave_cancellation_approved` | `notification.go:1378-1417` | obs | found |
| T-BEHAV-NOTIF-07 | notification | Cancellation-applied: **email** → single routed approver (leader, or site manager if applicant is own leader); **mobile** → HRs-of-nation + applicant. tmpl `leave_cancellation_applied` | `notification.go:1004-1020,1094-1107` | obs | found |
| T-BEHAV-NOTIF-08 | notification | Update-plan reminder → project leader (email), only when `hours>40 && office∈{1,2} && endDate > first-day-of-current-month` | `service.go:700-722`; `notification.go:1789` | obs | found |
| T-BEHAV-SE-01 | side-effect | rows written on create: `wcp_leave`, `wcp_leave_detail` (per day), `wcp_approve` (chain), `wcp_upload_file` (per attachment), `wcp_holiday_hour` (token mutate) | `brdg_impl.go:117-292` | obs | found |
| T-BEHAV-SE-02 | side-effect | no `wcp_holiday_hour_change_log` row on create (only on manual edit / withdrawal trim) | `brdg_impl.go:617-636` | obs | found |
| T-BEHAV-SE-03 | integration | leave email = SES over SMTP, in-process channel worker-pool (10), failures logged & dropped (no retry). Emails render via `html/template` (`handlers/notification/parse.go:5`) — user fields are escaped | `third_party/ses/ses.go:26-40`; `handlers/notification/parse.go:5` | obs | found |
| T-BEHAV-SE-04 | integration | S3 for attachments (presigned GET) and xlsx exports (`PutObject`) | `third_party/s3/s3.go`; `service.go:1776-1782` | obs | found |
| T-BEHAV-SE-05 | integration | no external queue; no calls to other services from the leave package | grep across leave/notification files | obs (scoped absence) | found (declare scope) |
| T-BEHAV-ABS-01 | absent | funeral/marriage/paternity change-log write is fully commented out — it does **not** happen | `service.go:615-675` | absent (proven) | absent — report as not-happening, not a feature |

## Report facet — M3

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-RPT-01 | pm-vs-dev | the state machine (§3) belongs in **both** reports; PM as a plain approval-lifecycle diagram, dev with the exact status constants & transition lines — same fact IDs | `leave-lifecycle.md §3` | obs | shared-claim, consistent |
| T-RPT-02 | pm-vs-dev | notification recipient unions (NOTIF-05/06) must appear in the PM report as "notifies X, Y, Z and …", never narrowed to one role; keep email vs mobile distinct | `leave-lifecycle.md §7` | obs | shared-claim; PM must not narrow |
| T-RPT-03 | dev-only | technical-fragility items (dropped SES errors, Special negative-guard gap, hours-escalation self-skip gap, approver-level mismatch) belong to the developer report only | `leave-lifecycle.md §11` | obs | dev-only; inferred items flagged |
| T-RPT-04 | coverage-honesty | JS prod-liveness (JS-LEGACY) must surface as **unresolved**, not omitted or guessed | this ledger | unresolved | declared gap |

## M4 — fresh-run assertions

| id | claim | expected |
|---|---|---|
| T-M4-01 | a fresh analysis of the frozen snapshot reproduces every `found` item above under its truth id | all `found` items accounted |
| T-M4-02 | the JS-LEGACY prod-liveness item is emitted as **unresolved**, counted in the denominator, never silently dropped | 1 declared gap |
| T-M4-03 | the module-only leave report (product + developer) is generated with shared fact IDs and no project-level docs, per PI-3 report-truth annotations | matches PI-3 report request |

---

## Actors / roles — facet M1+M2

The PM report (project & module) requires **roles**; the truth set had these only implicitly inside permission items. Made explicit:

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-ROLE-01 | role | applicant (employee) — creates leave; owner-only cancel | `service.go:57,1362` | obs | found |
| T-ROLE-02 | role | project leader = L1 approver | `approvement.go` (Level1); `brdg_impl.go:168-173` | obs | found |
| T-ROLE-03 | role | L2 / L3 managers = escalation approvers (hours>16 / >40) | `service.go:510,557` | obs | found |
| T-ROLE-04 | role | HR = approver for the 5 sensitive types; also balance editor | `brdg_impl.go:473-479`; `leaveHistory/service.go:149` | obs | found |
| T-ROLE-05 | role | site manager = cancel approver when applicant is their own leader | `service.go:1287-1303` | obs | found |
| T-ROLE-06 | role | Admin / HR = may act on any leave at any step | `service.go:371-375` | obs | found |

## Core business objects & lifecycle — facet M2

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-OBJ-01 | object | **Leave** (request) — the core object; its lifecycle IS the 9-state machine (§3) | `model/leave.go` | obs | found |
| T-OBJ-02 | object | LeaveDetail — per-day/segment consumption rows | `model/leave.go` | obs | found |
| T-OBJ-03 | object | Approve record — one per approval step (the trail) | `model` (`wcp_approve`) | obs | found |
| T-OBJ-04 | object | HolidayHour — per-user/per-year balance (the consumed resource) | `leaveHistory/serializer.go:37-65` | obs | found |
| T-OBJ-05 | object | UploadFile — attachment (doctor note etc.) | `brdg_impl.go:180-193` | obs | found |

## Cross-module relations — facet M1

Needed by both module reports (upstream/downstream) and by change-impact.

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-XMOD-01 | dep-out | leave → `handlers/support` (hour calc `CalculationAuto`/`Regular`) | import in `service.go`/`brdg_abst.go` | obs | found |
| T-XMOD-02 | dep-out | leave → `configs` (nation/location: HR emails, expiration windows) | imports (5×) | obs | found |
| T-XMOD-03 | dep-out | leave → `model` (project, employee, holiday lookups) | imports (7×) | obs | found |
| T-XMOD-04 | dep-out | leave → `handlers/notification` (email, html/template) + `notification/email` | imports | obs | found |
| T-XMOD-05 | dep-in | `leaveHistory` and `management` depend on the leave package | `leaveHistory/service.go:4`; `management/service.go:5` | obs | found |
| T-XMOD-06 | dep-in | routes wired in `handlers.go` (`leaveGrp`) | `handlers.go:96-112` | obs | found |
| T-XMOD-07 | cross-repo | shares `wcp_leave*` schema with `wcp-service` (JS owns migrations); called by `wcp-ui` | README | obs | found |
| T-XMOD-08 | cross-repo | JS `leaveService` still consumed by a live worklog-reminder cron + report exports (not the JS leave routes) | `wcp-service/services/notificationService.js:81` | obs | found |

## Test relations & change impact — facet M2/M1 (dev report, PI-48)

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-TEST-01 | test-relation | **no automated tests for the leave module** — 0 `*_test.go` in `handlers/leave` (the whole Go service has only 7 test files); 0 UI leave tests | `find *_test.go` → none | obs | found — a weak-test fragility stated as **evidence**, not opinion |
| T-IMPACT-01 | change-impact | changing leave affects: `leaveHistory`, `management` (Go imports); JS worklog-reminder cron, report exports, and billing (shared schema/service) | dependents grep | obs | found |

## Activation — config-exists vs reachable vs prod-unknown — facet M2 (PI-45)

PI-45 requires distinguishing declared config / reachable call / unconfirmable prod-enablement. Anchors:

| id | category | claim | evidence | res | expected |
|---|---|---|---|---|---|
| T-ACT-01 | activation | email send path is reachable (in-process) but delivery is best-effort/dropped — **production delivery not confirmable statically** | `ses.go:33-36` | obs + unresolved | found + prod-unknown |
| T-ACT-02 | activation | the Go `syncLvCompleted` cron (the `Completed` writer) is present and registered at startup; **whether it actually runs in production is not confirmable statically** | `third_party/cron/cron.go:19`; `wcp-service-v2/init/initialization.go:71` | obs + unresolved | found + prod-unknown |

---

### Open items for human verification (before this leaves DRAFT)
1. Independently pin the full creation-validation list (T-BEHAV-VAL-LIST) with `file:line` in-repo, not "agent evidence".
2. Confirm which `Leave` struct set GORM binds at runtime (handler-package vs `internal/model`).
3. Record clean/dirty state of each frozen root (PI-59 tooling).
4. Sample-review 10–15 items against source at the pinned SHAs and sign off.
