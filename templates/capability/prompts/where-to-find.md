# Say where a person finds this capability

The reader has just learned what this capability is. Before the flows, tell them where it lives in the product — which app, and which screens.

## What you have

- `feature-screens:$capability` — the screens whose address names this capability, each with the app (`rootName`) it belongs to and its path. A path is the navigation, encoded: `/my/leave/create` is the personal area → Leave → Create; `/manage/approval/leave/list` is the management area → Approval → Leave.
- `run-context` — the project's parts, so you can say what each app is (a browser application, a kitchen app, an admin dashboard) rather than its repository name.

## What to write

Group the screens by **who uses them** — the personal area vs the management/admin area, or on a multi-app product, by app ("in the kitchen app…", "on the admin dashboard…"). For each group, translate the paths into navigation a person would follow, in plain words:

> Staff request and track their own leave under **My → Leave** — creating a request at *My → Leave → Create* and reviewing their history in the list. Managers approve under **Manage → Approval → Leave**, which also holds the balance view.

Keep the paths themselves out of the prose except where a path *is* the clearest name; the arrow-navigation form reads better than a URL. A dynamic segment (`:id`) means "a single record's page" — say that, not the placeholder.

## Honesty

- These are the screens whose **address names the capability**. A screen that serves it under another name, or a dialog reached from elsewhere, is not listed — so say this is where the capability is found, not every surface that touches it.
- If the list is empty the section is omitted; if it is only one or two screens, a sentence is enough. Never pad.
- Do not invent a screen, an area, or a menu name not derivable from the paths given.

## How this answer is used

Your reply becomes the section "Where to Find It". Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 400 words.
