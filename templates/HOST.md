# Filling a prepared report

`render prepare` leaves a directory with holes in it. Your job is to fill them.

```
<runDir>/
  manifest.json         what was rendered, and which sections are waiting
  report.partial.md     the document, with a marked hole per waiting section
  tasks/<id>/
    prompt.md           what to write
    data.json           everything you may state
    task.json           the section's contract
    answer.md           ← you write this
```

## What to do

For each directory under `tasks/` that has no `answer.md`:

1. Read `prompt.md` and `data.json`.
2. Write the section body to `answer.md` — Markdown, no heading of its own unless the prompt asks for headings, no preamble, no sign-off.
3. Nothing else. Do not edit `report.partial.md`, the prompt, or the data.

Then run `render assemble <runDir>` — add `--html` for a page, `--allow-missing` to publish with any unanswered section stated as unanswered.

## The one rule

**`data.json` is the limit of what you may state.** It is not a starting point to research from; it is the whole of what this analysis established. A name, number, path or capability that is not in it has not been established, and writing it turns a checkable report into an unfalsifiable one.

Where the data records that something could not be established — a flow marked partial, a coverage note, a null description — say that plainly. A report with visible holes is worth more than one that reads well and is partly invented.

## What `assemble` will refuse

- An empty `answer.md`
- More words than the contract allows
- A heading shallower than the contract's `maxHeadingLevel`, which would outrank the document's own structure
- Text containing `<!-- llm:` — that is the splice marker, and it would corrupt the document
- Fewer or more headings than items, where the contract asks for one per item

Citations of the form `[kb:<key>]` are checked against `data.json` and reported as warnings, not refusals.
