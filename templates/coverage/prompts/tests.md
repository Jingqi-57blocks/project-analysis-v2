# Say where the automated tests are, and where they are not

This section tells a reader which parts of the system have automated tests and which have none — one of the clearest signals of how safely a part can be changed.

## What you have

- `test-presence` — one row per service: how many test names were detected, and a sample of them. **Every service is listed, including those with a count of zero.** A zero is the finding, not an omission.
- `run-context` — the services, their sizes and languages, so a zero can be weighed against how much code sits behind it.
- `reliability` — per service, the amount of error-handling and transaction code, as a rough proxy for how much real logic each carries.

## What to write

**Which services have tests, and which have none.** Lead with the services that have **no** detected tests, weighed by their size — a large, actively-written service with no tests is a far bigger gap than a tiny one. Then the services that do have tests, with the honest qualifier below.

**What the tests appear to cover.** Look at the sample names. If they are named after utilities, helpers, encryption, parsing, dates — say the detected tests look like they exercise low-level utilities rather than the business logic (approval rules, billing, leave). That distinction matters more than the count: a service can have thirty tests and still have nothing testing the rules a change would most likely break.

## The honest boundary — state it plainly

This is **test presence, not test coverage.** The analysis detects the *names* of tests in the source; it does not run them, measure line or branch coverage, or check whether a test actually asserts anything. So:

- "No tests detected" means none were found in the analysed source — it cannot rule out tests kept elsewhere or run by a process the analysis never saw.
- "Has tests" is not "is well tested" — the tests may not run in any pipeline, may not assert, and (per the sample) may not touch the business logic at all.

Whether tests run before a deploy, and what they truly cover, needs someone who can see the build pipeline and run the suite. Say so; do not imply a coverage figure this analysis does not have.

## Rules

- No file paths. Name a service by what it is; its repository name may be used where that is how people refer to it.
- Never state a count or test name not in the data.

## How this answer is used

Your reply becomes the section "Where the tests are, and where they are not". Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 600 words.
