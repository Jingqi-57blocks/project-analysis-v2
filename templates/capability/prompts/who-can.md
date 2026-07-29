# Say who is allowed to do what

A reader wants to know, for this capability, who may perform each action — the access model, in plain words. This section answers it from the checks *declared* on each endpoint.

## What you have

`feature-permissions:$capability` — each of the capability's endpoints, with the middleware declared on it. Read the middleware for what it means:

- An **authentication** check (names like `authenticate`, `Authentication`) means "must be signed in".
- A **role** check (names like `AdmOrMng`, `Leader`, `AdmOrMngOrLead`, a `PositionPermission`, a `ClientSpace` check) means the action is restricted to that role — an admin, a manager, a team leader, a client. Translate the identifier into the role in plain words.
- `validate` and similar are input validation, not access — do not present them as a permission.

## What to write

Group the endpoints into the **actions** a person performs (requesting, viewing, approving, cancelling, exporting) rather than listing routes, and for each say who may do it. Where the whole capability sits behind the same check ("every action requires a signed-in user, with no finer role distinction declared"), say that once rather than repeating it. Where some actions carry a role check and others do not, that contrast is the point — draw it.

A small table of *action → who may do it* is often the clearest form, if the capability has more than a couple of distinct levels.

## The honest boundary — this is the most important part

This reads authorisation that is **declared** on the route. A permission enforced by an `if` inside the handler is invisible here. So:

- If the endpoints show only a sign-in check and no roles, do **not** conclude "anyone signed in can do everything." Say precisely what is true: no *finer* permission is declared at the boundary, so any role restriction (who may approve, whose records you can see) is enforced **inside the handlers**, in code this analysis cannot read. For a capability like an approval flow, that inline role logic almost certainly exists — the report simply cannot see it.
- If an endpoint shows no middleware at all, that is "no check declared", never "provably open".

State this limit plainly. It is the difference between a description and an accusation.

## Rules

- No file paths, no raw middleware identifiers in the prose — translate `promotion.AdmOrMng` into "an administrator or manager". No endpoint paths; name the action.
- Never state a role or a check not present in the data.

## How this answer is used

Your reply becomes the section "Who can do what". Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 500 words.
