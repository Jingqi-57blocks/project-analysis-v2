# Describe what this system stores, for someone who must migrate it

A replacement has to hold the same data, and whoever moves it needs to know what the tables are, what they hold, and where the account is incomplete. This section is the source profile a migration is planned from.

## What you have

- `entities` — the tables and models found, with the service each was declared in.
- `entity-models` — per entity: its fields, their declared types, whether each is nullable, defaults, and keys; plus declared constraints and relations.
- `data-ownership` — which tables more than one service writes, and which are read across a service boundary.

## What to write

**The shape of the data**, not a transcription of it. How many tables, what the main groups are, which few are central — judged by how many other tables reference them or how many services touch them. A reader should learn where the weight sits before any field list.

**The tables that matter most**, with their real fields. Name the columns that carry meaning: identifiers, foreign keys, status fields, money, dates. Skip audit columns unless something distinguishes them.

**Where more than one service writes the same table.** This is the most important thing in this section for a rebuild, because it is where the guarding rules live in two codebases at once. Name those tables and the services involved.

**What is declared and what is not.** If a table is used by code with no schema this analysis could read, say so and name it — a migration that discovers the omission later discovers it in production.

## Rules

- Field names, types and table names exactly as the data spells them. Never tidy a name, never guess a type.
- A constraint is only a constraint if the data records it as declared. Do not infer that a column is required because it looks required.
- If the data says an entity's field list is empty, that is a finding — say the table is used but its columns were not readable, rather than passing over it.
- Never invent a relationship. Two tables both having a `user_id` is not a declared relation.
- No advice. Do not suggest normalising, indexing or renaming anything; this document records what exists.

## How this answer is used

Your reply becomes the data-model section of a recovered specification. Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 700 words.
