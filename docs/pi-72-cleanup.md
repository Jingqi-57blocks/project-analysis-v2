# PI-72 — entrypoint cleanup, target isolation, compatibility baseline

The small compatibility cleanup done before the CodeGraph and pipeline work, so
stale entrypoint docs do not mislead an agent and no target literal sits on the
production boundary. No architecture was rewritten; every change is independently
reversible.

## Fixed

- **README** brought to the current commands and structure: removed the "M0 is
  the MVP demo" status and the old `project-analysis-v2` Linear link (now the
  项目智能 V1 project), the nonexistent `fixtures/` layout entry and
  `fixture:setup` commands, and the MVP-era `engine/` description; added
  `engine/contracts/` and `pnpm verify:contracts`; corrected the target registry
  location; dropped a stale `57B-225` link.
- **Target config isolated out of the production engine.** The acceptance-target
  registry mechanism moved from `engine/targets/` to `tests/support/targets/`
  (`registry.ts` with the WCP-V2 / angels-pizza literals, plus `resolve.ts`,
  `derive.ts`, `types.ts`). The production engine now imports only the generic
  `engine/targets/digest.ts` (content hashing, no target literal). Production
  analysis never decided behavior from a target literal; this makes that
  structural, and lets the targets be absent or deleted without touching the
  engine.

## Retained (compatibility baseline)

- The `analyze → KB → prepare → assemble → validate/export` success path and the
  existing `overview` / `capability` / `coverage` templates are unchanged.
- The existing test suite is the characterization baseline: the cleanup is
  behavior-preserving, and the suite is **unchanged at 1124 passing tests before
  and after** — the zero-diff proof PI-72 requires. `pnpm verify:contracts` and
  the real-target suites (which skip gracefully when a target is absent) still
  pass with the registry in its isolated location.

## Deferred (tracked to the owning issue)

- CodeGraph batch import and version boundary — PI-5, PI-6.
- Provider/Reader inventory and migration matrix — PI-74.
- Universal behavior facts and side effects — PI-11, PI-12 (M2).
- The Report Pipeline that supersedes the current templates — PI-14 onward (M3).
- Removing the code-index-root exception — release/ops hardening (M6).
