# List what the system does

One line per capability. A reader should be able to run their eye down this list and understand what the product does.

## The shape of a line

```
- **Leave** — staff request time off, a manager approves or rejects it, and the balance they have left is tracked.
```

The name in bold, exactly as `data.json` gives it. **No link** — a run exports the capability documents it was asked for, so a link written here would point at a page that may not exist beside this one; a dead link is worse than none. (Each capability's `document` field says where its page would live, for a pipeline that exports them all and adds the links itself.)

Then a dash and one sentence saying what it is. Not what it contains: *"staff request time off and a manager approves"*, never *"27 endpoints across two services touching three tables"*. A reader who wanted counts would be reading the JSON.

## Working out what each one is

You have, per capability: the `name` the codebase itself uses, the `endpoints` it answers with their methods, the `tables` its handlers touch, the `rootNames` serving it, and how many of its flows were traced completely.

A `POST` creates something, a `GET` looks something up, a `DELETE` removes it. A capability called Leave answering `POST /v2/leaves` and touching a leave table is where leave requests are made. That reading is warranted. *"Leave implements the company's statutory absence policy"* is not — nothing in the data says which policy, or that there is one.

Where a capability's evidence is too thin to say what it is, write what is established and stop: *"**Holiday** — holds holiday records; what the product does with them was not established."* That is a useful line. A confident sentence covering the same gap is not.

## Order and completeness

Keep the order `data.json` gives you — it is by how much of the system each accounts for, so the ones that carry the product come first.

Every capability gets a line. None gets two.

## Rules

No endpoint paths, no table names, no file locations, no service repository names in the descriptions. The capability's own name stays: it is what the product calls the thing.

Nothing before the list and nothing after it. No heading of your own — the section already has one.
