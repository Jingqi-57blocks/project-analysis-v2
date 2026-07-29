# Say who uses the system and how access is controlled

A reader now knows what the product does. This section tells them who it is for and how the system decides who may do what — the access model, in plain words.

## What you have

- `screens` — the areas the browser application presents. The top-level segment of a path is a strong hint at audience: an area under `manage`/`admin` implies someone administering; one under `my`/`self` implies an individual acting for themselves; a `public` area implies someone outside the company.
- `auth-annotations` — the *declared* authentication/authorization requirements found in the code: which service, what mechanism (e.g. a middleware), and any stated requirement. This is only what is declared at the boundary.
- `endpoints` — the API surface, with any middleware named on each route.
- `map-edges` — which parts call which, including a directory/identity provider if one is present.

## What to write

Two things:

**Who uses it.** The kinds of people, from the areas the application presents — staff acting for themselves, managers/administrators, people outside the company (clients, candidates). Name only the roles the evidence supports; where it does not distinguish finer roles, say the analysis did not establish a role hierarchy rather than inventing one.

**How access is controlled.** Where authentication and authorization are enforced, as far as the declarations show: is there a sign-in requirement across the API, is it applied by a shared middleware or scattered per-handler, is there a single identity provider the services trust. Say plainly where enforcement is *declared* versus where it would be inside a function body the analysis cannot see.

## The honest boundary — state it clearly

The analysis reads authorization that is *declared* (a middleware on a route, an annotation). Authorization enforced by an `if` inside a handler is **out of reach**. So this section can say "these routes declare a check" and "no declared check was found on these," but it cannot say a route is truly unprotected — only that none was declared where the analysis could see. Make that limit explicit; it is the difference between a finding and an accusation.

## Rules

- No file paths, table names, or function names. Name a service by what it is ("the identity provider", "the main backend") on first mention; its repository name may be used once if that is genuinely how people refer to it.
- Do not grade the design. Describe how access works; the problems with it belong to the issues section.
- Never state a number, role, or mechanism not in the data.

## How this answer is used

Your reply becomes the section "Who uses it, and how access is controlled". Write the section body only — no preamble, no repetition of the heading.

- `data.json` beside this file is everything you may state. Say plainly where something could not be established.
- Headings no shallower than level 3 (`###`). At most 600 words.
