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
3. **Adversarial review by a subagent** (Opus, xhigh). Fix P0 and P1 only.
4. **Re-review after fixing.** Repeat until ACCEPT. Verify its findings by
   execution rather than accepting or dismissing them on reading.
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

## Phase 1 — make the knowledge base tell the truth about what it already read

Highest value per unit of work: each improves every existing report and unblocks
what follows.

| | Issue | Why here |
|---|---|---|
| 1 | **57B-293** | Follow the call graph we already walk to the tables a handler touches. Urgent, and 57B-290's real prerequisite. |
| 2 | **57B-298** | A table declared by a constant beside its struct. Returns 41 model files from "unread" to real entities and repairs the recovered data model. |
| 3 | **57B-299** | Tell a rejection's message from a string that happens to be nearby. The PRD's rules section is shipping with two wrong rows. |
| 4 | **57B-270** | Per-type behaviour as a lookup. Feeds both 57B-280 and 57B-290. |

## Phase 2 — turn the remaining silences into facts

| | Issue | Why here |
|---|---|---|
| 5 | **57B-269** then **57B-295** | The notification reader, then the section that reports what the system sends. A pair: the section is short without the reader. |
| 6 | **57B-255** | Work routed by writing a record — a state transition by another name. |
| 7 | **57B-271** | Rules and tables inside raw SQL. |
| 8 | **57B-272** | A check commented out beside a live route. Feeds 57B-291's matrix. |

## Phase 3 — the structure, and the sections a recovered specification needs

| | Issue | Why here |
|---|---|---|
| 9 | **57B-292** | Plan the document's structure from evidence, hold it for the run, keep it extensible. Everything below assumes it, and it removes the per-template duplication of `requires`/`fragment`/`contract`. |
| 10 | **57B-289** | Unread project facts signposted, misunderstood format parts omitted. Was blocked on 57B-268. |
| 11 | **57B-290** | Object state machines. Needs 57B-293. |
| 12 | **57B-280** | Field value sets, and the invariant boundary. |
| 13 | **57B-281** | Acceptance criteria and exception handling, asserting the code's own message. |
| 14 | **57B-291** | Roles and permission matrix. |
| 15 | **57B-279** | Join a page to its component, then read the tree. Re-scoped: the client-side route table is already read. |

## Phase 4 — assemble, measure, accept

| | Issue | Why here |
|---|---|---|
| 16 | **57B-278** again | The recovered specification with the sections Phase 3 added. |
| 17 | **57B-283** | Coverage and confidence, defined for a recovered spec. |
| 18 | **57B-282** | Migration mapping: the legacy side and an honest gap list. |
| 19 | **57B-273** | Make the report-against-source audit a standing step. |
| 20 | **57B-277** | Raise the parked Blueprint questions, if any now blocks. |

**Acceptance for both parents.** A full five-root run, every document rendered,
and an audit of each against the real code by a subagent: no wrong facts, no
material omissions, nothing stated beyond its slice. Then `feat` → `main`.

## Held out of scope

- **57B-276 and its five children** — the skill and its packaging. Held by
  instruction until both parents are done.
- **57B-266** — a record of audit evidence, not work. Close it with 57B-267.
- Branch pruning: 17 stale local branches, most already merged. Cosmetic, and it
  needs a decision rather than initiative.

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
