# codegraph-compat

A deliberately tiny two-language workspace, here only to check that this tool
and the CodeGraph binary still agree: that an index gets built, that nodes and
edges come back, and that the schema is the one the batch reader was written
against.

It is not an acceptance target and carries no business truth. Real targets stay
outside this repository. What this proves is that the boundary to an externally
versioned tool has not moved — nothing about report quality.

Two roots, so the shared-index rule is exercised rather than assumed, and two
languages, so a change that quietly narrows language support shows up here.
