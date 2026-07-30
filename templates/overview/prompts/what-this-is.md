# Say what this project is

You are writing the opening of a report for someone who has never seen this code and is not a developer. They should finish this section knowing what the system is and who uses it.

## Start with one sentence

The way one sentence explains Amazon: *a marketplace where sellers list products and buyers order them, with payment and delivery handled in between.* One sentence, no jargon, no hedging. If the evidence will not support a sentence that confident, write the most confident one it does support and say what is missing.

Then a short paragraph or two: what the system is for, who it serves, and roughly its scale — one honest number about size sets expectations before anything else. Say how it is built at a glance: how many parts, what kinds (a web front end, backend services, an identity provider), and the languages, from `run-context` and `map-edges`. A section immediately after this one tabulates every repository with its languages, versions and coverage, so name the shape and leave the inventory to it.

## Then name the one or two things that define it

A reader of an executive summary wants the shape of the system, not just its label. If the evidence shows a dominant structural pattern — two backends doing overlapping work, one service carrying most of the code, a front end that does nothing on its own — name it here in a sentence or two, plainly, as an observation. This is what turns "an HR platform" into "an HR platform whose work is split, mid-migration, across two live backends." Draw only on what the data shows (`map-edges` for how the parts call each other and the datastore; `reliability` for where the code weight sits); do not grade it, and leave the detail to the later sections — just give the reader the headline shape.

## Then say who uses it

The kinds of people, not the number of them. `screens` shows the areas the application presents — a path grouped under management or approval implies someone doing the managing or approving. `features` and their parts show what those people can act on. Name the roles the evidence supports: staff, managers, administrators, customers, delivery riders.

Where the evidence does not distinguish roles, say the analysis did not establish who uses it rather than inventing a hierarchy.

## What you have

- `run-context` — the project's name, its parts, how many files each holds, and the description the code carries about itself, or null if it carries none
- `features` — the capabilities found, with their endpoints, tables and evidence
- `screens` — the areas a browser application presents
- `map-edges` — which parts call which, and what they reach outside
- `reliability` — per service, how many error-handling sites and transactions were found: a rough proxy for where the code weight and complexity sit
- `evidence:readme-section` — prose the developers wrote, quoted as written

## Rules

Prefer the project's own words where it has any: quote briefly and say which part it came from. Where it carries no description, say so — the code carrying no description is a fact about the project, and a substitute you invent is not.

Never write a file path, a table name, an endpoint path, or a service's repository name where a plain description will do. "The web application people use" is better than `wcp-ui`; where a part's name is genuinely how people refer to it, use it once and move on.

Do not grade the project. No "well-structured", no "legacy", no "modern stack", no "needs work". A reader wants to know what it is, and the section on what is wrong with it comes later.

Do not describe the analysis. The reader wants the system, not the tool that read it.
