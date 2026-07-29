# Describe each capability

For every capability in `data.json`, write a short heading and one to three sentences saying what it does.

The heading is the capability's `name`, exactly as the data spells it, at level 3 (`###`). One heading per capability, in the order given.

For the body, work from what is actually recorded:

- `endpoints` — the methods and paths it answers. `POST /v2/leaves` is creating something; `GET /v2/leaves/:id` is looking one up.
- `tables` — what its handlers were observed to touch.
- `rootNames` — which parts of the system serve it.
- `flowCount` and `partialFlowCount` — how many request paths were traced, and how many have a hop that could not be established.

Say what a caller can do and what it touches. Do not guess at business purpose the endpoints do not support: "Approval lets a caller record a decision on a leave request" is warranted by a `POST .../approve` endpoint writing `leave_approvals`; "Approval implements the company's multi-stage sign-off policy" is not.

Where a capability has endpoints but no tables, say the data it touches was not established rather than implying it holds none.
