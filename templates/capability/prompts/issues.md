# Say what is wrong with this capability

Only this capability's own problems. Anything about the system as a whole belongs in the overview.

## What you have

`feature-findings-for:$capability` — each finding with what was observed and the evidence behind it.

## How to say it

In terms a reader can act on. Not *"endpoints-without-observed-auth, severity: notice"* but *"eight of the actions here were registered without any check that the person is signed in — a check written inside the handler would not be visible to this analysis, so this is worth confirming rather than assuming."*

Every finding here is an observation about what was analyzed, not a proven defect. Keep that distinction: say what was observed, and where a check might exist somewhere the analysis could not see, say so.

Worst first, judged by what it would cost someone using the system.

## Rules

No severity labels, no finding identifiers, no paths, no table names. If there are no findings, this section is omitted — do not write one saying everything is fine.
