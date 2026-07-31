# Roadmap: 57B-267 and 57B-275 to completion

The plan of record until both parent issues are Done. Read this before starting
any issue and before starting any phase. If work seems to require leaving the
order below, say so and get agreement first — do not improvise around it.

**Goal.** 57B-267 stops reports being quietly smaller than the truth. 57B-275
delivers Excavator's Stage 1 and Stage 2 from static code alone, of which
requirements synthesis — a specification recovered from source, in the shape
Blueprint reads — is the heart.

## Definition of done, per issue

An issue is not finished when its tests pass. All eight steps, in order:

1. **Branch from `feat/kb-truthfulness`**, named `57b-NNN`. Never from another
   issue branch. Confirm the base before cutting it.
2. Code and tests. `pnpm test` and `pnpm run typecheck` green.
3. **Review with the `code-review` plugin workflow**, at max effort rather than the
   Sonnet and Haiku tiers its file names, and with its five passes dispatched
   **concurrently** rather than by one agent in sequence — the serial run took
   sixteen minutes for work that has no ordering between its parts:
   (a) CLAUDE.md adherence, (b) a diff-only scan for real bugs, (c) git history and
   blame of the modified code, (d) comments on prior PRs touching these files,
   (e) the code comments in those files against what the change now does.

   **Passes (d) and (e) are why this workflow replaced the ad-hoc one.** Six
   adversarial rounds on 57B-278 missed two defects that (d) and (e) found at once:
   a branch returning a subject line published as a rule the system enforces —
   recorded as fixed on the sibling code path in PR #57's own comment — and a
   presentation-value skip that checked the wrong node kind, under a declared limit
   telling the reader such values could not appear.

   **Act on P0 and P1 only**, but have the reader report anything from 50 up: its
   own 80 threshold and its exclusion list ("test coverage", "lines the user did not
   modify", "pre-existing") drop classes that have blocked most rounds here, and a
   finding is worth seeing even when the answer is "not this issue".

   **Post the result on the PR**, as review comments at the lines they concern,
   each carrying where it now stands — fixed in a named commit, deferred to a named
   issue, or open. The PR is the record; a review that lives only in a terminal
   leaves the next reader to find the same things again.

   **Before dispatching, check my own new claims.** Render, and read every sentence
   the change added against the data behind it. Four of six rounds on 57B-278 were
   spent on sentences I wrote and never measured; twenty seconds against twenty
   minutes.

4. **Re-review only where the fixes warrant it**, and that is a judgement to make
   and state, not a ritual. Verify every finding by execution rather than accepting
   or dismissing it on reading: several were right in substance and wrong in cause.
   A fix that adds a sentence to a document needs the claim check of step 3 again; a
   fix measured against a fresh run of the real target does not need a second
   reader. A third round is a signal that the fixes are introducing defects, which
   calls for slowing down rather than reviewing again.
5. Commit subjects `57B-NNN: description`, whole-word identifiers, and never a
   deferred issue's identifier.
6. **Open a PR into `feat/kb-truthfulness`.**
7. **Set the Linear issue to In Review.**
8. **Merge, then set Linear to Done.** Only now may the next issue begin.

`feat/kb-truthfulness` merges to `main` once, at the end, as a single PR.

### What went wrong, so it is recognisable

Redirected mid-issue, a new branch was cut from an unlanded one: 57B-278's commit
landed on top of 57B-268's, with no PR for either and both issues still Todo in
Linear. Two commits, two issues, one branch, no record. The reviewer noticed
before the user did — *"the repo moved under me mid-review… worth confirming
which commit is going up for merge"* — and that warning was under-weighted.

**A redirection changes what is worked on next. It never changes steps 6, 7 and 8
for what is already in hand.** Finish landing the current issue first, even if the
next thing is more interesting.

## Phase 0 — land what is already built

Nothing new is written in this phase.

- **57B-268** — code and review complete, ACCEPT. Needs PR, Linear, merge.
- **57B-278** — committed on the wrong base. Rebase onto `feat` once 57B-268 is
  merged, then review it properly, then PR. It genuinely depends on 57B-268
  (`prd-not-recoverable` consumes both silence lists), so the order is real.
- **57B-300** — `pnpm run flow`, which prints how far behind the base each issue
  branch is, what unlanded work it holds in common with another issue's branch, and
  whether a pull request covers its commits; it exits non-zero when a branch holds
  another issue's unlanded work or carries a commit naming a different issue. The
  mechanism that makes the above unrepeatable, built after the rule was broken a
  second time within the hour of writing it. It claims no base and calls no branch
  merged, because neither is in the graph. **Run it before cutting a branch and
  before step 6.**

## Phase 1 — the spine, before anything else is added to a document

Every issue below Phase 1 adds to a document. Doing them first means adding to the
wrong shape and cutting twice.

| | Issue | Why here |
|---|---|---|
| 1 | **57B-305** | A third of the 48 "capabilities" are external services (`Openai`, `Jira`) or vocabulary fragments (`Year`, `Star`). Each carries a table row, an endpoint list and — under 57B-306 — its own document, so they inflate the very length 57B-303 measures. Independent of the standard, and needs none to be right. |
| 2 | **57B-303** | The length and content standard: complete on detail, as short as that allows, current state only. Everything downstream is written to it, and 57B-292's hand-written constraints cannot be judged without it. |
| 3 | **57B-292** | Plan the structure from evidence, with constraints over it as data. A full template is the limiting case, so today's templates become its strongest constraint set. |
| 4 | **57B-306** | Two audiences, product manager and engineer, as registrations rather than a flag. Plans into 57B-292. |

## Phase 2 — the truth about what was already read

| | Issue | Why here |
|---|---|---|
| 5 | **57B-293** | Read the call edges the index already holds. 0 of 520 entry points reach past their handler today; 415 with them. Unblocks 57B-290. |
| 6 | **57B-298** | A table declared by a constant beside its struct. Returns 41 model files from "unread" to real entities. |
| 7 | **57B-299** | Tell a rejection's message from a value a branch returns. Narrowed: presentation is fixed, the call-signature reading is what remains. |
| 8 | **57B-270** | Per-type behaviour as a lookup. Feeds 57B-280 and 57B-290. |

## Phase 3 — the remaining silences

| | Issue | Why here |
|---|---|---|
| 9 | **57B-269** then **57B-295** | The notification reader, then the section. A pair: the section is short without the reader. |
| 10 | **57B-255** | Work routed by writing a record — a state transition by another name. |
| 11 | **57B-271** | Rules and tables inside raw SQL. |
| 12 | **57B-272** | A check commented out beside a live route. |
| 13 | **57B-304** | Tell an unresolved call from no call. Depends on 57B-293's reading. |
| 14 | **57B-307** | Twelve real addresses missing from the Page Map, with `gaps: []` and a declared limit claiming the opposite. |

## Phase 4 — the sections a recovered specification needs

| | Issue | Why here |
|---|---|---|
| 14 | **57B-280** | Field value sets, pluggable per declaration form. Prerequisite for 57B-290, not a peer. |
| 15 | **57B-290** | Object state machines. Needs 57B-280 and 57B-293. |
| 16 | **57B-289** | Unread project facts signposted. Analysis gaps only; intent is not signposted at all. |
| 17 | **57B-291** | Roles and permission matrix. |
| 18 | **57B-281** | Acceptance criteria and exception handling, asserting the code's own message. |
| 19 | **57B-279** | Join a page to its component. Re-scoped: the 182 addresses are already read. |

## Phase 5 — assemble, measure, accept

| | Issue | Why here |
|---|---|---|
| 20 | **57B-283** | Coverage against real denominators, the behaviour fraction refused, confidence per fact. |
| 21 | **57B-282** | Migration mapping: the legacy side and an honest gap list. |
| 22 | **57B-273** | The document-against-source audit as a standing step, per section on change and whole at acceptance. |
| 23 | **57B-277** | The Blueprint register. Moved to Backlog: blocked on them, not on us, and it should not read as available work. |

## Held out of scope

- **57B-276 and its five children** — the skill and its packaging. Held by
  instruction until both parents are done.
- **57B-266** — cancelled. It was the citation list every reader issue was derived
  from, not work of its own, and left open it would have blocked the parent forever.
  The evidence stays readable on the cancelled issue.
- **57B-302** — delegating `engine/kb/query.ts`, the one file no move could shrink.
  Design change, not urgent.
- **57B-296**, **57B-284**, **57B-286** — a prompt keyed to one target, test
  scaffolding that must not ship, and SKILL.md's command surface.
- Branch pruning: stale local branches, most already merged. Cosmetic.

## Standing rules for this stretch

- **One issue in flight at a time.** Two open issue branches is the error above.
- **Grade against the real targets**, never a fixture written to be convenient
  to analyze. A fixture that needs editing before a test passes is the tool
  grading its own homework.
- **A reviewer's finding is verified, not accepted.** Several were right in
  substance and wrong in cause; two of mine were wrong in the opposite
  direction.
- **A section may state only what its slice holds.** Every wrong fact found so
  far came from prose reaching past its data.
