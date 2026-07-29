# Describe this module

Write the opening of a document about one module, for a developer who has to change it next week.

`data.json` gives you:

- `module-detail:$module` — the module, the capabilities it serves, its own endpoints, the parts it spans, and what grouped it
- `module-flows:$module` — the request paths through **this module's own endpoints**, hop by hop, with the tables each reaches

Two fields of `module-detail` are wider than the module: `dataEntities` and `outboundTargets` belong to the services it sits in, not to its own handlers. Do not attribute them to the module — say "the service declares" if you use them at all.

Say what the module is responsible for and how a request moves through it. The flows are the strongest evidence you have: a path that goes browser → route with auth middleware → handler → two tables tells you more than any name does.

Name what is not established rather than smoothing over it. A flow marked partial has a hop nobody could follow, and a reader planning a change needs to know which part of the picture is guessed at.

`groupingSignal` says why these traces were grouped into one module — a shared resource, a shared prefix. It is worth one clause, not a paragraph, and it is a fact about the analysis rather than about the code.

Do not evaluate the module's quality, and do not propose changes.
