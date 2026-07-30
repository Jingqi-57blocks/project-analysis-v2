# Say how much of the system this analysis actually understood

This is a coverage report. Its job is to tell a reader how far to trust everything else the analysis produced — how much of the system it followed, and how much it could not. Honesty is the whole point of this document; there is no such thing as too candid here.

## What you have

- `run-context` — the services, their languages, and how many files each holds; and how many endpoints belong to no capability.
- `signals` — the measures of the analysis itself: how many entry points could be followed into code and how many could not; how many traces completed; how many outbound calls were tied to a route; how many files were reached by some behaviour versus left unclassified.
- `coverage-notes` — the standing limits of the readers that ran.
- `repositories` — per repository: how many code files there are and how many yielded a fact, how many endpoints there are and how many were traced to their end, and how many tests were named. These are the numbers the sections below tabulate, so cite the ones that change what a reader should conclude and leave the rest to the tables.

## What to write

Give the reader a calibrated sense of reach, in plain proportions rather than raw counts where you can:

- **Breadth read.** How many files across how many services were analysed. State it as the denominator for everything else. Where one repository was read far less completely than the others, name it and say so — an average across five services hides the one a reader should doubt.
- **How much was followed.** What share of entry points were traced into code and what share were not; how many completed versus stopped early; how much of the outbound and data access could be resolved. Turn each into a plain statement — "almost all entry points were followed; a small remainder could not be tied to any code in the workspace."
- **The big caveat about behavioural reach.** If only a small share of files are reached by a trace and most are "technical-only" or "unclassified," say clearly what that means: the analysis mapped the system's *structure* well but followed comparatively few end-to-end *behaviours*, so the behavioural picture (traces, journeys) is a sample, not a census. This is the single most important calibration for a reader and must not be buried.

## Rules

- Present every measure as what it says about confidence, never as a grade of the project. "4% of entry points could not be followed" is a statement about the analysis, not a defect in the code.
- Prefer proportions and plain words to bare counts. Where a number carries real meaning (how many services, how many files), use it.
- Never state a number not in the data.

## How this answer is used

Your reply becomes the opening section of the coverage report. Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 600 words.
