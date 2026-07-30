# Say what states a record of this capability moves through

A capability's records usually live a small life — waiting, approved, rejected, completed. This section names those states and, where the evidence shows it, how a record moves between them.

## What you have

- `feature-status-sets:$capability` — the status/state sets declared for this capability, as the code names them. Use judgment on what each set *is*:
  - A set whose members are states (`WaitingL1Approve=1 … Cancelled=7`) is the lifecycle itself. Where a code set and a display set mirror each other (`LvStatusC` / `LvStatusF`), they are one lifecycle — use the display names, they are already human words.
  - A set mapping states to colours or badges is a **UI map**, but its member *names* still enumerate real states — use the names, ignore the colours.
  - A set that is actually configuration (members like `total`, `page`, `limit`) is not a lifecycle — ignore it entirely.
- `feature-guards:$capability` and `feature-decisions:$capability` — where transitions show themselves: a guard like "Already approved/cancelled." says approval is only reachable from a waiting state; a decision branching on `waiting for l1 approve / l2 / l3` says which states route where.

## What to write

**The states, named.** List the states in the order the values suggest, in plain words. If two parts of the system declare *different* state sets for the same records — one with seven states, one with nine — that disagreement is a first-class fact: say which part knows which states, and what a record in a state the other part lacks would mean.

**The movement, only as evidenced.** Draw a mermaid `stateDiagram-v2` **only for transitions the guards/decisions actually show** — an approval chain whose order is visible, a cancellation that requires an approved record. Where the states are known but the movement between them is not, write the states as a list and say plainly: *"how a record moves between these states was not established."* A tidy invented state machine is worse than an honest list.

## Honesty

- The sets here are the ones **named for this capability**. A status set named for something else that this capability also uses would be missed — say the lifecycle is drawn from the capability's own declared states.
- If no status sets were supplied, say in one sentence that no declared states were found for this capability, and stop.

## How this answer is used

Your reply becomes the section "The states it moves through". Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 600 words.
