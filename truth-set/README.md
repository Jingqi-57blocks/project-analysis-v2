# WCP-V2 Leave — Truth Set (draft v0.1)

Ground-truth reference for the **leave feature** of WCP-V2, recovered from static
source only. This is the human-authored/verified standard that the analyzer's
fresh-run output is graded against (project issue **PI-3**).

> **Status: DRAFT for human source-verification.** Every claim here was extracted
> from the code by reading it, and every claim carries a `file:line` citation so a
> human can check it against source. Nothing here should be treated as blessed
> truth until a domain reviewer has sampled it against the frozen revisions below.
> An AI-authored truth set used to grade an AI-built extractor shares blind spots;
> the human review is what breaks that circularity (PI-3 acceptance).

> **Corrected 2026-07-31 after a source review against WCP-V2.** Fixed several factual
> errors that would have wrongly failed a correct report: `Completed(6)` is reachable (a
> Go cron writes it, not a dead state); leave emails use `html/template` (so the earlier
> broadcast HTML-injection risk was false and is removed); notification recipients differ
> by channel (email vs mobile) and were previously conflated; the update-plan trigger and
> the same-day-prompt behaviour were wrong. This still proves the value of the review step
> — the draft is **not** ready to be blessed as an M4 scoring baseline until the remaining
> open items are closed and a domain reviewer signs off.

## Files

| File | What it is |
|---|---|
| `README.md` | scope, frozen revisions, method, the JS-vs-Go verdict, the resolution vocabulary, caveats |
| `leave-lifecycle.md` | the full lifecycle understood in detail — states, the state machine, approval routing, cancellation, notifications, data effects, integrations, exceptions |
| `leave-truth-set.md` | the structured, facet-tagged truth ledger (the machine-checkable form) |
| `leave-risks.md` | prioritized risks & problems (subjective engineering judgement, grounded in cited code) |

## Scope — the live leave feature

The leave **feature** (apply → approve/reject → cancel, plus balances, notifications,
export) is served by:

- **`wcp-service-v2`** (Go) — the backend. Most leave logic is under
  `internal/handlers/leave/` (+ `leaveHistory/`, `constant/leave.go`, `model/leave.go`),
  but **not all**: the `Approved → Completed` transition is a cron in
  `internal/third_party/cron/cron.go`, and email rendering is in
  `internal/handlers/notification/` (`html/template`).
- **`wcp-ui`** (React/TS) — the frontend, under `src/pages/leave/`. Its API client
  `leave-service.ts` calls Go `/v2/*` (leaves, plus holiday, holiday-hour, calculation);
  **no static call to the legacy `/leaves*` API was found**.

The legacy **`wcp-service`** (Node/JS) is **out of scope for the leave feature** —
see the verdict below.

## Frozen revisions

Static analysis is only reproducible against a pinned snapshot. HEAD SHAs read
directly from each root's `.git` (no `git` command was run inside the read-only
target):

| root | language | HEAD SHA |
|---|---|---|
| `wcp-service-v2` | Go | `7db2ee8d2670993fe185d7293d6a315753602acd` |
| `wcp-ui` | React/TS | `b86dfa27e95f2109dcd9bcbdec147b62dbc8312d` |
| `wcp-service` | Node/JS | `9df6897542a15025dbda798f0c30d769c59c36ed` |

These three SHAs are valid commits and equal the current HEAD of the `~/Documents/WCP-V2`
clones (the registry default). Any check must use that clone — a separate `~/Documents/WCP`
clone exists at different revisions and differs in some files (e.g. `ses.go`).

**Dirty state not captured** — `git status` is forbidden inside the target by the
read-only rule. The acceptance-target freeze tooling (PI-59) must record clean/dirty
per root; until then, treat these SHAs as HEAD-at-read-time only.

Unless a citation says otherwise, paths are relative to
`wcp-service-v2/internal/handlers/leave/` at SHA `7db2ee8d`.

## Verdict: is the JS service used by the leave feature?

**No, for the HTTP leave API — but `wcp-service` is not "dead," and static code
cannot prove the old routes get zero traffic.** Precisely:

- `wcp-service/routes/leave.js` exposes 11 real (non-stubbed) leave endpoints mounted
  at `/leaves` (`wcp-service/app.js:100`). **No static caller of those `/leaves*`
  HTTP endpoints was found in any of the 5 roots** — the UI calls `/v2/leaves*` (Go)
  for every leave operation. Resolution: **`routes-exist-but-no-static-caller`**, i.e.
  *superseded*, **not** *proven-dead*.
- `wcp-service` is still alive for the leave **domain** in two ways that matter:
  1. **It owns the leave DB schema.** All `wcp_leave*` migrations live in
     `wcp-service/migrations/` (through 2025, e.g. `20250206075445-leave-add-uto-field.js`);
     `wcp-service-v2` has **no migrations of its own** and reads/writes the same tables.
  2. Its `leaveService` module is still called by a **live cron** (weekly missing-worklog
     reminder excludes leave days, `wcp-service/services/notificationService.js:81`) and by
     report-export paths (`/reports/leaves` etc.).
- **What static code cannot settle:** whether the legacy `/leaves*` routes still receive
  production traffic from a caller outside this workspace (mobile app, API-key client,
  manual use). "No caller in these 5 repos" ≠ "zero production traffic." That needs
  runtime evidence (access logs / APM).

This distinction is itself a truth item (see `T-STRUCT-JS-LEGACY` in the ledger) and a
worked example of why the resolution vocabulary below is not optional.

## Method

Recovered by reading the source directly (four parallel read-only passes: JS-usage
verification, creation+model, approval/rejection, cancellation+notifications+history),
each returning exact `file:line` + code quotes. No file in the target was modified;
no `git` command was run inside it. Synthesis and judgement were done in one place
against those quotes.

## Resolution vocabulary (how to read every claim)

Each truth item is tagged with how well the code supports it. These are the same
distinctions the analyzer's own contract must encode (PI-55), forced into existence by
this first real target:

- **observed** — directly present in code at the cited line.
- **inferred** — a reasonable reading not fully proven (e.g. a suspected copy-paste bug,
  or which of two duplicate structs GORM binds at runtime). Flagged, never asserted as fact.
- **unresolved** — the code implies a fact exists but the evidence can't settle it (e.g.
  whether the legacy JS `/leaves*` routes still receive production traffic — not knowable
  statically). An honest gap, distinct from "absent."
- **absent (proven)** — checked and genuinely not there (e.g. the funeral/marriage change-log
  write is fully commented out — it does **not** happen).

## Facets

Each truth item is tagged with the gate(s) it belongs to, so M1–M4 can each filter its own:

- **M1 (structure)** — entry points, files, symbols, call edges, DB tables.
- **M2 (behavior)** — decisions, rules, states/transitions, permissions, validations,
  exceptions, side effects, notifications, test relations.
- **M3 (report)** — how a fact should surface in the PM vs developer report, shared fact IDs.
- **M4 (fresh-run)** — items asserted against a full fresh analysis of the frozen snapshot.

## Alignment with the V1 dual-report content contract

Cross-checked against the *V1 双报告通用内容合同* (Linear doc `c4af4294b4bf`) and the
section issues PI-14/44/45/46/48. Two things the reader should know:

- **This truth set is at *module* scope** (leave), matching the PI-3 M4 request
  (leave module × {product, developer}). Per the contract, module scope expands *every
  evidenced branch* (which this does) and keeps cross-module trigger/result references
  (the `T-XMOD-*` items) — but it deliberately does **not** carry project-scope content
  (project boundary, full module map). That is a different ReportTarget.
- **The report's problem ledger must be priority-neutral — `leave-risks.md` is not that.**
  The contract and PI-48 explicitly forbid subjective priority/severity ranking and
  remediation in V1 report output; a problem is recorded as `problemId · scope · category
  · observed|inferred|unresolved · confidence · fact/diagnostic IDs · citation · impact
  boundary`, with no ranking. So **`leave-risks.md`'s P1/P2 ordering is a development-time
  judgement for *us*, not report content.** To grade the report's problem section, each
  risk must be re-expressed in that neutral form (the facts are the same; the ranking is
  dropped). The `T-RPT-*` and `R*` items should be reconciled into one problem ledger
  with stable IDs before this leaves DRAFT.

The cross-check also added truth items the report sections need that were missing:
**roles** (`T-ROLE-*`), **business objects** (`T-OBJ-*`), **cross-module relations**
(`T-XMOD-*`), **test relations & change impact** (`T-TEST-*`, `T-IMPACT-*`), and
**activation** distinctions (`T-ACT-*`).

## Caveats

- Draft, unverified by a human domain reviewer (see Status).
- Item schema is provisional — PI-1/54/55 will fix the canonical shape; this uses a
  readable stand-in (id, facet, category, claim, evidence, resolution, expected-status).
- Not exhaustive: the ~47 creation validations are enumerated in full in
  `leave-lifecycle.md §Validations`; the ledger captures the load-bearing ones and points there.
