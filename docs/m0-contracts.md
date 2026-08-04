# M0 contracts

The versioned, executable product/execution/acceptance contracts every later milestone
builds on. Linear documents define the product and migration intent; these repository
artifacts are the machine-readable, verifiable form.

## Verify

```
pnpm verify:contracts
```

One offline command: loads every contract, runs its validator, checks the positive/negative
fixtures, and recomputes the bundle digest against `engine/contracts/lock.json` (drift gate).
It reads committed data only — never a target folder — so it runs in CI without the targets
present. CI runs it before the test suite; a drift, a failed validator, or a fixture that
misbehaves fails the build.

## Contracts

| id | source | data | what it fixes |
|---|---|---|---|
| `shared-fact` | `engine/contracts/shared-fact/` | — | fact identity, evidence, provenance, resolution; confidence/activation/gap/applicability; merge/conflict/schema-version |
| `report-instructions` | `skills/project-report/` | — | the documents a report is written from, digested so an edit to any chapter is a contract change; plus the investigation checklist ids the audit enforces |
| `truth-leave` | `engine/contracts/truth/` | `truth-set/leave/ledger.json` | the WCP-V2 leave golden-slice truth set |
| `sentinel-angels-pizza` | `engine/contracts/truth/sentinel.ts` | `truth-set/angels-pizza/sentinels.json` | the angels-pizza generalization sentinels |
| `targets` | `engine/contracts/targets/` | `truth-set/targets.json` | the frozen acceptance targets and revisions |
| `rubric` | `engine/contracts/rubric/` | — | coverage denominators, severities, gates and the golden-slice hard thresholds |

## Changing a contract

A contract's shape is digested in `engine/contracts/lock.json`. To change one: bump its
version, run `pnpm relock`, and provide a migration where a consumer's data must change.
Editing a contract without updating the lock fails `verify:contracts` — that is the drift
gate, not a nuisance.

Regenerating the lock is a deliberate act after a deliberate version bump. It is never the
fix for a red build.
