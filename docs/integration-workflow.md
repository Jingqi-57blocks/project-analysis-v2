# PI V1 integration workflow

How every change in the **项目智能 V1** (Project Intelligence, `PI`) effort reaches the
repository. Authoritative task order, scope and acceptance live in Linear
(blockedBy/blocks and issue bodies); this file is the versioned copy of the git and PR
mechanics so any agent can recover them from the repo alone.

## Branch topology

- `main` — stable. Receives **no** intermediate PI V1 implementation until release.
- `feat/project-intelligence-v1` — the single long-lived integration branch for the
  whole effort. Created from clean `main` at base SHA `40834fd5973ab2a601dc26a742da13a09ed5de48`.
- `codex/pi-<number>-<short-slug>` — per-leaf-issue work branch, cut from the latest
  `feat` HEAD (never from `main` or another unmerged work branch).

Parent / rollup issues get no code branch; their children each deliver a PR and the
parent only aggregates acceptance.

## PR contract

- One leaf issue → one work branch → one PR. Multi-issue PRs are disallowed unless the
  code is genuinely inseparable and Linear records why, listing every issue ID with its
  own acceptance disposition.
- PR base is `feat/project-intelligence-v1`.
- PR title and commit subjects: `PI-XX: <summary>`.
- PR body must carry: a Linear issue link and a `Fixes PI-XX` line, acceptance
  disposition, non-goals, contract/schema/migration impact, test commands + results,
  self-review with P0/P1 disposition, and remaining/blockers. The `pr-contract` CI job
  fails the PR if the Linear link, `Fixes PI-XX`, test evidence or acceptance section is
  absent.
- Issue status flows from the linked PR; do not hand-edit issue state.
- A blocked issue's PR is not merged until its Linear blocker is done.
- After merge, delete the work branch. Fixes to already-merged work enter feat through a
  new issue/branch/PR, never by pushing to feat directly.

## Test tiers

- Work branch: run the issue's unit / contract / fixture / migration tests.
- Before merge: the PR required checks (`build-and-test`, `pr-contract`) must pass.
- After merge to feat: run the affected milestone's integration/regression tests at
  `feat` HEAD. A red feat HEAD is not a stable base for the next issue — open a fix issue
  first.
- Milestone exit and the M4/M5/M6 fresh-run, golden-slice, sentinel, performance,
  reproducibility, packaging and distribution audits all run on `feat` HEAD, recording
  branch, commit SHA, Linear issue, command, result and artifact digest.

## Branch protection

- `main`: pull request required, 1 approving review, admins included, no force-push, no
  deletion. This makes the final `feat → main` PR require an explicit maintainer approval.
- `feat/project-intelligence-v1`: pull request required, required status checks
  (`build-and-test`, `pr-contract`), no force-push, no deletion. No human-approval gate:
  a single-actor workflow would deadlock on it, so the "required review" is met by the
  mandated self-review of the full diff (P0/P1 fixed and re-reviewed) before merge.

## Merging to main

Only after PI-33's release gates all pass on one `feat` HEAD is a single
`feat/project-intelligence-v1 → main` PR opened, linked to PI-33, re-running the full
release gate, and merged only on explicit maintainer approval. No PI V1 PR is ever based
on `main` before then.
