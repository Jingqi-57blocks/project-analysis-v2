# Say what data the system owns, and what it shares

This section tells a reader where the system's data lives, who is in charge of each part of it, and — the part that matters most for changing the system safely — where two services touch the same data without a clear owner.

## What you have

- `data-ownership` — one row per table, with the services that **write** it, the services that only **read** it, and a `sharing` classification:
  - `single-owner` — one service writes it; the safe, ordinary case.
  - `read-across-a-boundary` — one service writes it, another only reads it. A change to how the owner stores the data reaches the reader with no interface in between to catch it.
  - `written-by-several` — more than one service writes it. The rules that guard that table are then enforced in more than one place, and the two can drift apart.
- `entities` — the tables/among the schema the analysis read, for scale.
- `run-context` — the services and their languages.

## What to write

Start with the shape: roughly how many tables there are, and how they split across `single-owner` / `read-across-a-boundary` / `written-by-several`. One honest sentence of scale.

Then the part that matters: the **shared and cross-boundary data**. Name the tables that more than one service writes (translate `wcp_leave` → "leave records", `wcp_approve` → "approval records" — drop the prefix, say the thing). Say which services, and what the consequence is: the same record written by two services, with the guarding rules living in two codebases. Do the same for the read-across-a-boundary tables, with the honest caveat below.

If most tables are single-owner, say so plainly — clear ownership is a good property and worth stating, not just the problems.

## The honest boundary

A shared *name* is not proof of a shared physical database — two services may declare a table of the same name and connect to different instances; the analysis reads declarations, not connections. And a write expressed through a data-model layer rather than a named table may not be visible, so a "read-across-a-boundary" table might actually be written by the reader in a way the analysis missed. State these limits where they apply; they turn a claim into something a reader can check rather than an overstatement.

## Rules

- Translate table names into what they hold. Never print a raw `wcp_`-prefixed name where a plain noun works; if you must anchor one, do it once.
- No counts standing in for meaning — "seven tables are written by two services each, including leave, approvals and holiday balances" is a sentence; "7 written-by-several" is not.
- Never state a table, service, or number not in the data.

## How this answer is used

Your reply becomes the section "The data it owns, and what it shares". Write the section body only — no preamble, no repetition of the heading.

- `data.json` beside this file is everything you may state. Say plainly where something could not be established.
- Headings no shallower than level 3 (`###`). At most 700 words.
