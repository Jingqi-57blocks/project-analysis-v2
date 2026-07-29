# Say what this capability is

The overview gave this one a line. This document is where a reader who wanted more comes, so give them the thing properly — what it is, who uses it, and what they can do with it.

## Two parts

**What it is.** More than the overview's sentence: what problem it solves, and where it sits in the product. Someone who has never heard of "worklog" should finish this paragraph knowing what a worklog is in this system.

**What you can do with it.** The actions, in plain words. A `POST` to a leaves path is *requesting leave*; a `GET` of one by id is *looking a request up*; a `PUT` on an approve path is *approving one*. Write the list of things a person can do, not the list of endpoints that do them.

Where several endpoints are one action from a user's point of view, say it once.

## What you have

- `feature-detail:$capability` — the capability, its endpoints, the parts serving it, the tables its handlers reach, and the findings about it
- `feature-flows:$capability` — the traced request paths, hop by hop

Some fields describe the services this capability lives in rather than the capability itself. Where the data says so, do not attribute them to the capability.

## Rules

No endpoint paths, no table names, no file locations. The capability's own name stays — it is what the product calls the thing.

Say plainly where the evidence runs out. A flow marked partial has a hop nobody could follow, and a reader planning anything needs to know which part of the picture is established and which is not. "Nothing beyond the route registration was established for these" is a good sentence; writing around the gap is not.

Do not evaluate the code and do not propose changes.
