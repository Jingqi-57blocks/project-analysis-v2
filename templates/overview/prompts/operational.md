# Say how the system runs, and how it copes with failure

This section is for a reader deciding how much to trust the system in production: how each part handles errors and transactions, what it depends on, and what the analysis could and could not see about its operational readiness.

## What you have

- `reliability` — per service: how many error-handling sites, transaction boundaries, and *discarded errors* (a call dispatched so its result — including any failure — is thrown away) the analysis found. These are **counts of presence, not verdicts**: a catch block says nothing about whether it swallows the error or handles it well. A service with zero transaction boundaries either does not need them or does not use them — the analysis cannot tell which.
- `dependencies` — the third-party packages each service declares, by ecosystem.
- `run-context` — the services and languages.

## What to write

**How work is made safe (or not).** Which services wrap their database work in transactions and which appear not to — with the caveat that "none found" can mean "not needed" for a read-mostly or frontend part. Where a service has many error-handling sites, say it copes with failure in many places, but be explicit you cannot say whether those handlers recover or merely log-and-continue.

**Fire-and-forget work.** Where discarded errors cluster, name it: work dispatched to run on its own whose failure nothing records. This is the operational risk the analysis *can* see clearly, so give it weight — say what kind of work tends to be dispatched that way (notifications, follow-ups) if the number is meaningful.

**What it leans on.** A sentence on the dependency footprint per ecosystem — a rough sense of how much third-party code each service carries.

## The honest boundary — be direct about it

Static analysis of committed code **cannot** observe: whether tests run in CI, whether health checks probe dependencies, whether there is alerting or tracing, whether a job retries, or whether an integration is live in production. If those are not in the data you were given, do **not** guess them — say plainly that operational readiness of that kind is not something this analysis established, and that it needs a human who can see the running system. Naming the limit honestly is more useful than a confident guess.

## Rules

- No file paths or function names. Name a service by what it is.
- Present counts as presence, never as quality. "1,438 error-handling sites" means error handling is pervasive, not that it is good.
- Never state a number, service, or dependency not in the data.

## How this answer is used

Your reply becomes the section "Operations & Reliability". Write the section body only — no preamble, no repetition of the heading.

- `data.json` beside this file is everything you may state. Say plainly where something could not be established.
- Headings no shallower than level 3 (`###`). At most 600 words.
