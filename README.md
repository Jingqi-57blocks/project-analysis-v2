# Project Analysis V2

A knowledge base for a target project's code.

Point it at any number of source folders — git or not, any language — and it
analyzes them once into a structured, queryable knowledge base. Reports are
rendered from that knowledge base by editable templates, never by re-reading
the source.

The first two templates are a project overview and a per-module detail report.
They are the first version, not the specification: the knowledge base is
designed so a template nobody has written yet still works against it.

## Status

Early. See the [Linear project](https://linear.app/57blocks-prd/project/project-analysis-v2-39519a3d7a1d)
for the current plan — M0 is the MVP demo.

## Layout

```
engine/     deterministic analysis — filled in from MVP 2 onward
templates/  prompt templates over the knowledge base
fixtures/   demo workspaces used to develop and grade every stage
scripts/    development tooling
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run fixture:setup     # prepare git state in the demo fixture
```
