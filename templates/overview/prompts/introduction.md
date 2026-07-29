# Introduce the project

Write the opening of a report about a codebase somebody else has to take over.

You have, in `data.json`:

- `run-context` — the project's name, its parts, and the description its own code carries (or null, if it carries none)
- `features` — the capabilities the analysis found, with the endpoints, tables and files behind each
- `map-edges` — which parts call which, and what they reach outside themselves
- `evidence:readme-section` — prose the developers wrote, quoted as written

Say what kind of system this is, what it appears to be for, and how it is put together. Ground every claim in the data: a capability named "Leave" with endpoints under `/v2/leaves` and a `leaves` table is evidence of leave management; the same name with nothing behind it is not.

Where the project describes itself, prefer its own words to yours — quote briefly and attribute to the part it came from. Where it does not, say the code carries no description rather than inventing one.

Two things to avoid. Do not grade the project: no "well-structured", no "legacy", no "modern stack". And do not describe what the analysis did — the reader wants the system, not the tool.

If the data is thin, a short and honest paragraph is the right answer. Length is not the goal.
