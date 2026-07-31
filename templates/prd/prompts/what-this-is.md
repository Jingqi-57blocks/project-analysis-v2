# Say what this system is, for someone rebuilding it

This is the opening section of a specification **recovered from source code**, which will be read by a team who will build a replacement. They have never seen this system. They need to know what it is, what it is made of, and how much of the account below they can lean on.

## What you have

- `run-context` — the services analysed, their sizes, the project's name, and whatever description the repositories' own documentation carried.
- `features` — the capabilities detected from the system's own vocabulary, each with the endpoints it owns and the tables its files touch. `tables` are those read or written in the file handling one of its endpoints and `tablesNearby` those touched elsewhere in that file's package: both are wider than the capability, so treat them as where its data lives rather than as what it owns. `tablesTruncated` says at least one of its traces reached more tables than it names, so never present either list as the complete set for a capability carrying it.
- `repositories` — one row per service: what it appears to do, how many code files it holds, how many endpoints it serves, how completely it was read.
- `screens` — the addresses the browser application serves, where there is one.

## What to write

**What kind of system this is**, in two or three sentences: how many services, what each broadly does, whether there is a browser application, roughly how large. A reader should be able to picture the shape before any detail arrives.

**What it appears to be for**, and here the boundary matters. If `run-context` carries a description from the repositories' own documentation, you may report what it says — attributed as that, not as a finding. If it does not, say the code states no purpose. Do not infer a product's goal from the names of its capabilities: "there is a capability named Billing" is a fact; "this is a billing platform" is a guess.

**What it is made of**: the capabilities, named, with a sense of which are large and which are small. Cite the endpoint or table counts where they distinguish one from another.

**How much of this account is solid.** State the read proportions honestly, and name any service read markedly less completely than the others. A reader deciding how much to trust the rest of the document is entitled to that up front.

## Rules

- Every number must come from the data. Never state one that is not there.
- Never name a capability, service, table or path that is not in the slice.
- Do not say what the system is *for* beyond what a description in the data states. A recovered specification that invents purpose is worse than one that admits it has none — the section after this one exists to say so plainly, so you do not need to compensate here.
- Do not grade the project. "Two services have no detected tests" is a fact about the analysis; "the project is under-tested" is a judgement this document has no standing to make.
- Plain sentences. No marketing register, no "robust", no "seamless".

## How this answer is used

Your reply becomes the opening section of the recovered specification. Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 500 words.
