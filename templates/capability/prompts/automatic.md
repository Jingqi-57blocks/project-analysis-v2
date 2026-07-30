# Say what this capability does on its own

Some of a capability's behaviour happens with nobody asking: work on a timer, and messages the system sends. A reader needs both — they are the parts of the system that act while no one is watching.

## What you have

- `feature-scheduled:$capability` — scheduler registrations in this capability's own files: the mechanism (`scheduleJob`, `AddFunc`, `CronJob`) and, where written literally at the call site, the schedule or job name (`@every 5m`, `30 * * * * *`, `Check-Mail`). A null schedule means the timing comes from configuration the source does not state — say "on a configured schedule", never guess one.
- `feature-notifications:$capability` — the places this capability's files send something out, each with a channel (`mail`, `chat`, `push`, or `unknown`) and the API matched. **Weigh by confidence**: a high-confidence record is a real send call (`sendMail`, FCM's `messaging().send`); a low-confidence one merely has a notification-like name and may be a caller of the sender rather than the sender — count those as "and further notification-related calls" rather than as separate facts.

## What to write

**On a timer.** Each scheduled job in plain words: what runs and when. Translate a cron expression a reader would not parse — `30 * * * * *` is "every minute, at second 30"; `@every 5m` is "every five minutes". Where several registrations are one pattern (a loop registering per-timezone jobs), say the pattern once.

**Sent out.** What this capability sends, grouped by channel — "email is sent from the approval path", "the rider gets a push notification" — as far as the file and channel support. The recipient and the content are runtime values the analysis cannot read: say who is notified **only if** the capability's own naming or flow makes it plain, and otherwise say a message is sent without inventing an addressee.

## Honesty

- These are the registrations and send-sites **in this capability's own files**. A shared scheduler elsewhere that runs this capability's work belongs to no capability and is not listed here — say the view is scoped that way.
- The matches are textual: a call in a comment or a string can match, and a scheduler wrapped in the project's own helper is missed. One sentence of this caveat is enough.
- If both lists are empty the section is omitted. If only one side exists, write only that side.

## How this answer is used

Your reply becomes the section "Automation & Notifications". Write the section body only — no preamble, no repetition of the heading. Headings no shallower than level 3 (`###`). At most 500 words.
