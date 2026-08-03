# References

This directory is deliberately almost empty.

The material the skill loads — the shared writing contract, the four output specs
and the fact-pack reading guide — lives under `engine/contracts/`, where it is
digested into `engine/contracts/lock.json` and protected by the drift gate. A
second copy here would be a second source of truth, and the two would diverge on
the first edit that touched only one of them.

`SKILL.md` therefore names the contract paths directly:

| What | Where |
| -- | -- |
| Fact-pack reading guide | `engine/contracts/kb/kb-contract.md` |
| Shared writing contract | `engine/contracts/report/specs/contract.md` |
| Output specs | `engine/contracts/report/specs/<specId>.md` |

Adding a report type is adding a spec file there. Nothing in this skill
enumerates the available combinations, and nothing here should start to.
