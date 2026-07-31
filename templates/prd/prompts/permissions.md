# Say what the system checks before it acts

A replacement has to apply the same checks. This section says which ones were found, and — more usefully — where none was.

## What you have, and what it actually contains

- `auth-annotations` — one record per check found, carrying a `mechanism` (the *kind* of pattern that matched, such as `auth-middleware` or `guard`), a `requirement` (the token beside it), and a file and line. **It does not distinguish authentication from authorization**, and it does not carry the route it guards. Where a `symbolId` is present it is the symbol the check sits inside, not the endpoint it protects.
- `endpoints` — every entry point, with its method, path, service and the middleware names it passes through. **This is the sounder evidence**, because a middleware list is read from the route registration itself.

## What to write

**Endpoints with no check this analysis could read.** Lead with these, counted and grouped by service, naming the paths. Where a path is conventionally open — a health check, generated API docs, a static mount, a password reset that necessarily runs before anyone is signed in — say so, because a reader scanning for problems should not have to work that out alone.

**What guards the rest**, from the middleware names on the endpoints. Group by middleware and give counts. Where a name plainly indicates the kind of check — one containing `Authentication` against one containing `Authorization` or `Permission` — you may report what the name indicates, attributed to the name rather than asserted as a property of the check.

**What the annotations add**, if anything: how many were recorded, in which services, and where their limits make them unreliable.

## Rules

- **"No check found" is not "no check required."** Write the first, never the second. A check inside a handler, or in a proxy in front of the service, would look identical here.
- **Do not claim that any role may reach any endpoint.** Nothing in this slice joins a role to a route. That sentence cannot be written from this data however strongly the names suggest it.
- **Do not present a count of authorization checks as distinct from authentication.** The data does not separate them — both arrive under the same `mechanism` — and only a middleware's *name* hints at which it is. A hint is what you may report. If you find yourself writing "N endpoints require authorization", check that you are reading middleware names and say so.
- **Never infer a role hierarchy.** If nothing states that an administrator can do what a manager can, do not say it.
- Quote a `requirement` or a middleware name exactly as the data spells it, and do not reconstruct the annotation it came from — the original syntax is not in the slice.
- If a service's annotation count is out of proportion to its size, say so and treat it as an artefact. The reader matches by name where a language has no declarative annotations, which over-matches badly in a service whose whole subject is authentication.

## How this answer is used

Your reply becomes the access-control section of a recovered specification. Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 500 words.
