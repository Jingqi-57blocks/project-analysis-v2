# Say who may do what

A replacement has to enforce the same access rules. This section says what the code checks, and — just as importantly — where it checks nothing.

## What you have

- `auth-annotations` — the authorization checks found, each with the route or symbol it guards and the role or permission it names.
- `endpoints` — every entry point, with its method, path, service and the middleware it passes through.

## What to write

**The roles the code names**, taken from the checks themselves rather than from any list. If a role appears in one check only, say so; a role's frequency is part of its meaning.

**What each role may reach**, grouped so a reader can see the shape: which areas are role-restricted, which require only authentication, and which require nothing at all.

**Endpoints with no check at all.** Lead with these if there are any. An entry point that passes no authorization middleware is the single most useful thing this section can tell a team about to rebuild the system — and it is a statement about what was *read*, so say that too.

## Rules

- **"No check found" is not "no check required."** Say the first; never write the second. A check expressed in a way this analysis does not read would look identical here, and the difference matters enormously.
- Never infer a role hierarchy. If the code does not state that an administrator can do what a manager can, do not say it.
- Quote the annotation or middleware name as written.
- Do not count an authentication check as an authorization check. Knowing who someone is and deciding what they may do are different, and the data distinguishes them.
- If the annotation reader's limits are in play — matching by name alone over-matches in an auth-centric codebase — say the count may include names that are not checks.

## How this answer is used

Your reply becomes the permissions section of a recovered specification. Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 500 words.
