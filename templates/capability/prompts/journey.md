# Describe what happens when someone uses it

Follow a request through, in words, so a reader understands the sequence without reading a diagram.

## What you have

`feature-flows:$capability` — each traced path, step by step: where the call came from, the route that received it with any middleware on it, the handler behind it, and the tables reached. A step carrying an `unresolvedReason` is one nobody could follow.

`feature-decisions:$capability` — the choices the code makes in this capability's files: what is being decided, the branches, and whether taking each one stops the request or carries on.

`feature-screens:$capability` — the screens whose address names this capability. Where a journey plainly starts from one of them, open it there — *"from My → Leave → Create, the request goes to the service…"* — naming the screen as navigation, never as a raw path. Only where a matching screen exists; never invent one.

## How to write it

Take the main path first — the thing this capability is mostly for — and narrate it: *"the request arrives, is checked for a signed-in user, the balance is read, and if there is enough the request is recorded and the manager sees it in their list."*

Then the variations that matter. A decision with branches is usually the interesting part: say what is being decided and what each answer leads to.

Where several endpoints follow the same shape, describe the shape once rather than repeating it per endpoint.

## Where it is not established

Say so, in place. If the handler behind a route could not be identified, the honest sentence is that the request reaches the system and nothing beyond that was established — not a plausible continuation. If every path in this capability stops at the same point, say that plainly and stop; a short honest section is the right answer.

## Rules

No endpoint paths, no handler names, no table names, no file locations. Middleware becomes what it does — "only signed-in users can do this" — not its identifier.

Do not draw a diagram. The section after this one draws the decisions from the same data.
