# Symbol readers, graded

Two readers can supply symbols: the in-process declaration reader
(`engine/providers/symbols/`), which parses with ast-grep, and the CodeGraph
adapter, which shells out to an external indexer that writes a cache into the
directory it indexes.

Measured on both targets, 2026-07-29, everything else held fixed.

## WCP-V2 — 5 roots, 2,114 files, all Go/TypeScript

| | symbols | routes | flows | handler steps | table steps | traces | modules | features |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CodeGraph only | 11,982 | 721 | 444 | 438 | 3,745 | 520 | 16 | 41 |
| declarations only | 10,284 | 718 | 444 | 438 | 3,745 | 520 | 16 | 41 |
| both, partitioned | 10,284 | 721 | 444 | 438 | 3,745 | 520 | 16 | 41 |
| both, unpartitioned | 19,650 | 721 | 444 | **38** | **184** | **63** | **13** | 41 |

The in-process reader alone reproduces every downstream number, with 14% fewer
symbols — CodeGraph counts fields and parameters, which nothing consumes. It
also runs in 12.9s against 29.6s.

## angels-pizza — 7 roots, 1,785 files, mostly JS/JSX/Vue

| | symbols | routes | flows | modules | features |
|---|---:|---:|---:|---:|---:|
| CodeGraph only | 6,321 | 487 | 259 | 88 | 22 |
| declarations only | 3,599 | 108 | **0** | **0** | **0** |
| both, partitioned | 6,245 | 487 | 259 | 88 | 22 |

This is why CodeGraph stays. It supplies **486 of the 594 routes** here — the
framework readers cover 108 — and without those entry points no capability
forms at all. On this project it is carrying more than symbols.

## Why they must not overlap

Run together without partitioning, handler resolution on WCP-V2 falls from 438
to 38. Two providers describe one function under different identities, so both
records survive rather than merging, and the linking stage reads two symbols of
one name as ambiguous — correctly, since it cannot know they are the same.

The fix is not identity alignment but partition by file: the declaration reader
takes what it can parse, CodeGraph takes the rest.

## One defect this grading caught

The declaration reader first spelled a method `Server.Serve`. The linking stage
tells a method from a plain function by `::`, so every function/method name pair
read as ambiguous and handler resolution sat at 134 instead of 438. One
character, and no unit test would have found it — only running the whole
pipeline against a real project does.
