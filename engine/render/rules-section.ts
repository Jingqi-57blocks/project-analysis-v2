/**
 * What the system refuses, and in whose words.
 *
 * Its own module: the rule table carries more accounting than any other section —
 * one row per message per repository, conditions scoped to the repository stating
 * them, and how each branch leaves — and it was the largest thing in a file already
 * over the readable ceiling. A move, not a rewrite.
 */

import type { GuardRecord } from "../structural/rules.js";
import { FRAME_EN, t, type Glossary } from "./strings.js";
import { pick, table, type Fragment } from "./parts.js";

/** Conditions shown per rule before the rest are counted. */
const TESTS_PER_RULE = 2;

interface Rule {
  message: string;
  kind: string;
  /** How the branches stating it leave: thrown, returned, or both. */
  exits: Set<string>;
  /**
   * The conditions under which this rule rejects, per repository.
   *
   * Kept apart rather than pooled: the same message is enforced in two codebases
   * under conditions that are not the same rule. `sort params is invalid` allows
   * four columns in one service and one in another, and a pooled cell printed
   * wcp-service-v2's Go whitelist under wcp_review_service's heading — a rebuild
   * reading it implements the wrong allowed set.
   */
  testsBy: Map<string, Set<string>>;
  /** Every `<root>/<path>` that states this rule, which is more than one often. */
  where: Set<string>;
}

/**
 * How the rule was stated, and how the branch stating it leaves.
 *
 * The second half is the distinction the table was missing. A `throw` refuses to
 * do the work; a `return` may refuse — Express and Go reject by building a response
 * body — or may be a value, and this reader cannot tell which. `policyEmailSubject`
 * returns one subject line per branch, and those lines were published as rules the
 * system enforces beside twenty-five UI labels, with nothing to mark them.
 */
function statedAs(f: Glossary, rule: Rule): string {
  const kind = t(f, `message-kind-${rule.kind}`);
  if (rule.exits.size === 0) return kind;
  const exits = [...rule.exits].sort().join("-and-");
  return `${kind}, ${t(f, `exit-${exits}`)}`;
}

/**
 * The conditions under which a rule rejects, one per line.
 *
 * Two were joined with `·`, which under a column headed "When" reads as one
 * compound trigger: `status === 0 · status === UserStatus.Inactive` are two
 * mutually exclusive checks in two files, and a rebuild implements the
 * conjunction. 78 of WCP's 686 messages have more than one distinct condition and
 * one has thirteen, all silently dropped past the second.
 */
function conditions(f: Glossary, tests: ReadonlySet<string>): string | null {
  const all = [...tests].sort();
  if (all.length === 0) return null;
  const shown = all.slice(0, TESTS_PER_RULE);
  const rest = all.length - shown.length;
  return [...shown, ...(rest > 0 ? [t(f, "and-more", rest)] : [])].join("<br>");
}

/**
 * How many distinct rejection messages to name per repository.
 *
 * High enough to print every rule a real workspace states: WCP-V2's largest
 * service alone holds 493 distinct messages, and at 400 the recovered
 * specification ended that table with `and 93 more` — counted, but 93 of the
 * biggest service's rules absent from a document meant to be built from.
 *
 * Per repository, so the headroom is thinner than it looks: those same five roots
 * analysed as one monorepo root would be 686 against this cap.
 */
const VALIDATION_PER_ROOT = 1000;


export const VALIDATION_FRAGMENTS: Readonly<Record<string, Fragment>> = {
  /**
   * What the system rejects, in the words it rejects with.
   *
   * The strongest material a recovered specification has: each row is a rule the
   * code enforces and the sentence it states when the rule is broken, quoted
   * rather than paraphrased. A rebuild that reproduces these reproduces the
   * behaviour a user actually meets.
   *
   * Deliberately not grouped by capability here — the same message often guards
   * several routes, and one list with locations is shorter than the same rule
   * restated per feature.
   */
  "prd-validation": (input) => {
    const f = input.frame ?? FRAME_EN;
    const guards = pick<readonly GuardRecord[]>(input, "guards") ?? [];
    if (guards.length === 0) return t(f, "prd-no-validation");

    const byMessage = new Map<string, Rule>();
    for (const guard of guards) {
      const entry = byMessage.get(guard.message) ?? {
        message: guard.message,
        kind: guard.messageKind,
        exits: new Set<string>(),
        testsBy: new Map<string, Set<string>>(),
        where: new Set<string>(),
      };
      if (guard.exit !== undefined) entry.exits.add(guard.exit);
      if (guard.test !== null && guard.test !== "") {
        const tests = entry.testsBy.get(guard.rootName) ?? new Set<string>();
        tests.add(guard.test);
        entry.testsBy.set(guard.rootName, tests);
      }
      entry.where.add(`${guard.rootName}/${guard.source.relPath}`);
      byMessage.set(guard.message, entry);
    }

    // Not by how often a message repeats. Ranking that way filled every row with
    // a repeated message and hid 623 rules stated in one place each — and noise
    // repeats, so a CSS value outranked a real rule. Grouped by repository and
    // ordered by message instead, and the cap is high enough to print them all
    // on a real workspace, because the example this format follows lists every
    // validation message rather than a sample.
    //
    // A rule enforced in two repositories appears under both. Filing it under
    // whichever file happened to be walked first printed WCP's password rules once,
    // under a proposal-share modal, with the service that also enforces them
    // reduced to "and 1 more file(s)" — and a rebuild most needs to know that a
    // rule lives in two codebases at once.
    const byRoot = new Map<string, Rule[]>();
    for (const entry of byMessage.values()) {
      for (const rootName of new Set([...entry.where].map((at) => at.split("/")[0]!))) {
        const group = byRoot.get(rootName) ?? [];
        group.push(entry);
        byRoot.set(rootName, group);
      }
    }

    const parts = [t(f, "prd-validation-lead")];
    const single = byRoot.size === 1;
    for (const [rootName, group] of [...byRoot.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "en"),
    )) {
      if (!single) parts.push(t(f, "silent-in", rootName));
      group.sort((a, b) => a.message.localeCompare(b.message, "en"));
      const shown = group.slice(0, VALIDATION_PER_ROOT);
      parts.push(
        table(
          [t(f, "col-rejects-with"), t(f, "col-when"), t(f, "col-stated-as"), t(f, "col-enforced-in")],
          shown.map((entry) => {
            // Where this rule lives in *this* repository. Naming a file in another
            // one under this heading is how the cross-repository case was lost.
            const here = [...entry.where].filter((at) => at.startsWith(`${rootName}/`)).sort();
            const elsewhere = entry.where.size - here.length;
            return [
              entry.message,
              conditions(f, entry.testsBy.get(rootName) ?? new Set()),
              statedAs(f, entry),
              [
                here.length === 1 ? here[0]! : t(f, "and-files", here[0]!, here.length - 1),
                elsewhere > 0 ? t(f, "also-in-other-repositories", elsewhere) : null,
              ]
                .filter(Boolean)
                .join(", "),
            ];
          }),
        ),
      );
      if (group.length > shown.length) {
        parts.push(t(f, "and-more", group.length - shown.length));
      }
    }
    parts.push(t(f, "prd-validation-note"));
    return parts.join("\n\n");
  },

};
