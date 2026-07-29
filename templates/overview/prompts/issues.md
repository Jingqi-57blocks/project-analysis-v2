# Say what is wrong with it

What a reader should know before trusting this system — at the level of the whole project. Problems belonging to one capability are covered in that capability's own document and do not belong here.

## What counts

`structural-findings` are the ones about the architecture: a table two services both write, a boundary that is not held, something the analysis found true across parts rather than inside one.

`signals` measure the analysis rather than the product. Read them for what they imply about the system — "no two services were found calling each other" says something about how the parts are joined — but do not report a measurement as a defect.

## How to say it

In terms a reader can act on, not in the words the analysis used internally.

Not: *"unguarded-writes, severity: concern, 3 occurrences."*
Instead: *"Two parts of the system both write the same records, and neither checks what the other did — so the same request handled by different parts can leave different results."*

Say what the consequence is for someone using or running the system. If you cannot say what a finding would mean to them, state the finding plainly rather than inventing a consequence.

## Order

Worst first, judged by what it would cost the people using the system — not by the severity label. A contradiction that produces different answers for the same request matters more than an unusual arrangement of code.

## Where there is nothing

If nothing project-level was found, say exactly that, and say what it does and does not mean: findings come from what the analysis was able to read, so nothing found is not the same as nothing wrong. Do not pad the section to look thorough.

## Rules

No severity labels, no finding identifiers, no file paths, no table names, no counts standing in for meaning. State nothing that is not in the data — where you are describing a consequence rather than a finding, the consequence must follow from what the finding actually says.
