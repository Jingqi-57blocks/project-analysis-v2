# Run cost

What was measured: wall-clock duration of `pnpm run analyze`, `pnpm run report`, a
CodeGraph-enabled report on one root, and `pnpm test`, observed from outside the
process (`/usr/bin/time -p` around CLI invocations, `performance.now()` around
function calls in throwaway scripts — no timing instrumentation was added to the
engine). Machine: MacBook, Apple M1, 16 GiB RAM, macOS 26.5.2 (Darwin 25.5.0),
Node v22.16.0, pnpm 10.12.2, CodeGraph 1.5.0. Measured 2026-07-29.

Each scenario was run at least twice from a deleted scratchpad `.sqlite` (or a
fresh output directory) to check consistency; numbers below are stable across
repeats unless noted.

## Results

| # | Scenario | Input shape | Wall-clock |
|---|----------|-------------|------------|
| 1 | `pnpm run analyze` — WCP-V2 | 5 roots (Go: `wcp_review_service`, `wcp-auth`, `wcp-service-v2`; JS: `wcp-service`; TS/TSX: `wcp-ui`). 2,114 files analyzed, 14 excluded, 0 unsupported, 0 failed | **1.01–1.03 s** (3 runs) |
| 2 | `pnpm run analyze` — angels-pizza | 7 roots, all JS/JSX/Vue (`admin-backend`, `backend`, `ionic-vue`, `kitchen`, `rider-app`, `web-admin`, `web-vue`). 1,785 files analyzed, 3 excluded, 0 unsupported, 0 failed | **1.02 s** |
| 3 | `pnpm run report` — WCP-V2, no CodeGraph | same 5 roots as #1. Output: 0 features, 35 components | **1.64–1.67 s** (2 runs) |
| 4 | `generateReport` + CodeGraph — WCP-V2/wcp-auth only | 1 root, Go. 51 files analyzed / 2 excluded per the engine's own inventory walk; CodeGraph's own `listFiles` reports 44 (its file set differs slightly from the engine's inventory — not reconciled here). Output: 0 features, 5 components. **Warm CodeGraph index** (pre-existing `.codegraph/codegraph.db`, refreshed via `codegraph index -q`, not a cold `codegraph init`) | **23.4 s** (internal `performance.now()`, 2 runs: 23.4s / spot-check consistent) / **24.06 s** real (`/usr/bin/time`, includes ~0.6 s tsx/node startup) |
| 5 | `pnpm test` (full suite) | 45 test files, 571 tests, all passing | **30.48 s** real (vitest's own reported "Duration": 29.88s) |

Analyze (#1, #2) is intentionally cheap: `runAnalyze` only does workspace
selection, root snapshotting, inventory walk/classification, and provider
preflight — it does not run structural extraction. That work (manifests,
outbound, conventions providers, evidence assembly, structural assembly,
linking, module formation, health signals) happens in `generateReport`, which
is what #3 and #4 exercise. This is why #1/#2 are ~1s for ~2,100 and ~1,785
files respectively while #3, without CodeGraph, is ~1.6s for the same 5 roots
as #1 — a few hundred ms more for the extra pipeline stages, still trivial.

## CodeGraph breakdown (run #4, wcp-auth)

Measured directly by calling `ensureIndexed`, `queryNodes`, `listFiles`, and
the callee-query loop from `engine/providers/codegraph/cli.js` in a standalone
script (not through the provider), run twice:

| Step | Run A | Run B |
|------|-------|-------|
| `ensureIndexed` (warm, `index -q`) | 569.4 ms | 565.1 ms |
| `queryNodes` (486 nodes returned) | 168.8 ms | 171.7 ms |
| `listFiles` (44 files returned) | 162.9 ms | 162.0 ms |
| callee-query loop (136 callable symbols) | **22,330.5 ms** | **23,828.3 ms** |
| **Total** | 23,233.0 ms | 24,728.5 ms |

The callee-query loop dominates: **~96% of total CodeGraph extraction time**,
one `codegraph callees <symbol>` subprocess per callable (function/method)
symbol.

- Callable symbols queried: **136** (out of 486 total nodes returned by
  `queryNodes`; 371 callee edges came back in total)
- Per-symbol subprocess cost: avg **164–175 ms**, median **~164–165 ms**,
  min **~157–159 ms**, max **173 ms** (Run A) / **532 ms** (Run B, one outlier)
- This is consistent with the subprocess-per-symbol design documented in
  `engine/providers/codegraph/provider.ts` and `cli.ts`: "one subprocess call
  per callable symbol, so extraction time grows with symbol count."

At ~165 ms/symbol, a root with materially more callable symbols than
wcp-auth's 136 (e.g. `wcp-service`, `wcp-service-v2`, or `wcp-ui`, all larger
than wcp-auth by 4–20x file count) would scale roughly linearly in this one
sub-step, on this same warm-index basis.

## What was NOT measured, and why

- **A cold CodeGraph index.** All 5 WCP-V2 roots already had a `.codegraph/`
  index on disk before this measurement session (all indexed at various
  earlier timestamps). Per the constraint against modifying targets beyond
  the accepted `.codegraph/` exception, existing indices were not deleted to
  force a cold-start measurement. The `ensureIndexed` timings above (~565–569
  ms) reflect an incremental `codegraph index -q` refresh of an
  already-initialized index, not a `codegraph init` first-index cost — those
  are known to differ substantially and the difference is not measured here.
- **A full-workspace report WITH CodeGraph.** Run #4 was scoped to the single
  `wcp-auth` root (44–51 files, 136 callable symbols) as instructed. A report
  over all 5 WCP-V2 roots with the CodeGraph provider enabled — which would
  multiply the callee-query loop by however many thousands of callable
  symbols exist across `wcp-service`, `wcp-service-v2`, and `wcp-ui` combined
  — was not run and is not estimated here.
- **CodeGraph against angels-pizza.** No `.codegraph/` index exists in any
  angels-pizza root, and indexing it was not part of the requested run list;
  doing so would itself be a cold-index measurement and was skipped for the
  same reason as above.

No run failed, timed out, or was retried to get a better number; every figure
above is a directly observed measurement.

## What this means

The standing rule: performance work is warranted only when a single full
generation exceeds 40 minutes.

Nothing measured here comes close to that line. The most expensive scenario
observed — a CodeGraph-enabled report scoped to one 44-file root — took about
23–25 seconds. The full test suite took about 30 seconds. Every other
measured scenario (`analyze` on both targets, `report` without CodeGraph on
the full 5-root WCP-V2 workspace) completed in under 2 seconds.

The one number this report does not have is a full-workspace, CodeGraph-
enabled report over all 2,114 WCP-V2 files — the scenario closest to a "real"
worst case, given the callee-query loop's linear-in-symbol-count cost. Based
on the measured per-symbol rate (~165 ms) and wcp-auth's ratio (136 callable
symbols in 51 files, roughly 2.7 symbols/file), a workspace-wide run would
need on the order of several thousand callee subprocesses; even a rough
extrapolation stays in the minutes-to-tens-of-minutes range, not hours — but
this is explicitly an extrapolation, not a measurement, and is flagged as
such rather than reported as fact. No optimization is proposed here either
way; that decision should wait for an actual measurement against the 40-minute
line.
