# CodeGraph batch adapter — design (PI-5)

The boundary PI-6 implements against. It replaces, not supplements, the current
per-query CLI adapter; there is no second CodeGraph provider. The contract types
are in `batch.ts`.

## The problem it replaces

The current adapter reads nodes in one CLI query but resolves call edges with one
subprocess per callable symbol — measured at ~96% of a run on WCP-V2, which is
why `callEdges` is off by default. That N+1 also cannot see the graph's full
edge and unresolved-reference data. A single batch read removes both limits.

## Batch read boundary

- **Prefer the official TypeScript API.** If it can enumerate nodes, edges and
  unresolved references for an index in one pass, it is the import path.
- **Fallback: an isolated, read-only, version-pinned index database.** Only if
  the API cannot fully enumerate the graph. The database shape is CodeGraph's
  internal format and stays behind the adapter (see Isolation); the adapter opens
  it read-only.
- **Interactive commands (`explore`, `impact`) are not the base import path.**
  They are per-query by design — exactly the shape that makes the current adapter
  N+1 — and are used, if at all, only to fill a specific gap after the batch read.

## One snapshot

`read(indexRoot)` returns one `CodeGraphSnapshot`: `nodes`, `edges`,
`unresolvedReferences`, `metadata` and `truncation`. One read enumerates
everything the M1 import tasks (PI-34 nodes, PI-35 relations, PI-36 unresolved +
provenance) need; none of them queries per symbol.

## Isolation

CodeGraph's internal format never reaches the shared model. A record carries the
graph's `nativeId` (a raw identity, kept beside the canonical id per the
shared-fact contract, never inside it); the canonical FactId is assigned when the
snapshot is normalized into the model. Internal schema types are private to the
adapter.

## Version and schema gate

`metadata` always records the CodeGraph version and snapshot schema, so an
upgrade cannot silently change a reported fact — a surprising result traces to
the version that produced it. `checkVersionGate` fails closed when CodeGraph is
absent or the schema is unsupported; a version that merely differs from the
verified `1.5.0` still works but is recorded (`versionDiffersFromVerified`).

## Degradation (fail closed)

A read that cannot produce a trustworthy snapshot returns a `DegradationReason`
(`version-incompatible`, `schema-unsupported`, `index-incomplete`,
`index-build-failed`) — never a partial snapshot presented as success. An
incomplete index degrades rather than reporting a codebase as smaller than it is.

## Index lifecycle and read-only guarantee

The index lives outside every analyzed source root; nothing is written into
analyzed source. Creation, reuse, lock, path and cleanup stay as they are in
`cli.ts` (`sharedIndexRoot`, `ensureIndexed`, `withIndexLock`) — the batch adapter
changes how the index is read, not where it is written.
