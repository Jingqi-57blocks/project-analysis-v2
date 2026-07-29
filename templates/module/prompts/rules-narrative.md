# Put the rules into words

The table above already lists this module's rules. Turn them into prose a reader can follow.

You may only restate what is in `data.json`. Every rule there carries:

- `statement` — the rule in words, with values named where the project names them
- `text` — the comparison exactly as the code writes it
- `guarded` — `rejects` if failing the check stops the request, `continues` if it carries on, null where it guards no branch
- `meanings` and `valueSetName` — what the value stands for, where the project declares a name for it

Group rules that are about the same thing and say what they add up to. Where two rules disagree — the same limit written two ways, or one part checking `> 40` while another checks `>= 40` — that is the most useful thing on the page, so lead with it and quote both.

Where a rule's value has no name in the project, say the number stands unexplained. Do not guess what it means.

This section is optional. If the rules are few and the table already reads clearly, say so in a sentence and stop.
