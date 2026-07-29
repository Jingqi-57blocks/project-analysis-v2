/**
 * The sections code can fill: tables, diagrams, lists.
 *
 * A fragment gets the slice its section asked for and returns Markdown. It
 * states facts and nothing else — no adjectives, no conclusions, no counts
 * dressed as judgements. Anything that needs a sentence about what the facts
 * mean is an `llm` section with a prompt someone can edit.
 */

import type { KnowledgeBase, Coverage } from "../kb/query.js";
import type { CoverageNote, FeatureFact, MapEdge, RunContext } from "../kb/facts.js";
import { bestSetFor, type ValueSet } from "../semantics/enums.js";
import { escapeLabel } from "../flows/mermaid.js";
import { FRAME_EN, t, type Glossary } from "./strings.js";

export interface FragmentInput {
  /** Selector name → what it resolved to, in the order the section listed. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  readonly kb: KnowledgeBase;
  /** The report's frame words. English when a caller supplied no language. */
  readonly frame?: Glossary;
}

export class FragmentError extends Error {
  constructor(name: string) {
    super(`Unknown fragment "${name}". Available: ${fragmentNames().join(", ")}`);
    this.name = "FragmentError";
  }
}

type Fragment = (input: FragmentInput) => string;

function pick<T>(input: FragmentInput, selector: string): T | undefined {
  return input.data[selector] as T | undefined;
}


/**
 * A value as a person would say it.
 *
 * `constant.PtoC` is a package, a name and a Go constant suffix; a reader
 * wants "pto". `wcp_leave_detail` is a table prefix and underscores; they
 * want "leave detail".
 */
function readableValue(text: string): string {
  // `constant.PtoC.Uint8()` names PTO and then converts it; the conversion is
  // not the value. Drop call segments before taking the last one.
  const segments = text.split(".").filter((segment) => !segment.endsWith("()"));
  const last = segments[segments.length - 1] ?? text;
  return readableName(last.replace(/C$/, "").replace(/^[a-z]{2,4}_/i, ""));
}

/** An identifier as a person would say it: `lv.LeaveType` → "leave type". */
function readableName(text: string): string {
  // A subject can be a call — `toLower(item.name)`. What is being decided on is
  // the argument, not the call, and splitting a call on "." left a stray `name)`
  // as the label. Unwrap to what is inside the parentheses first.
  const unwrapped = /^[\w.]+\((.+)\)$/.exec(text.trim())?.[1] ?? text;
  const last = unwrapped.split(".").pop() ?? unwrapped;
  return last
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/[()]/g, "")
    .toLowerCase()
    .trim();
}

/** The names a project gives the values a branch tests, where it gives any. */
function nameValues(
  values: readonly (string | number)[],
  subject: string,
  sets: readonly ValueSet[],
): string | null {
  const set = bestSetFor(subject, sets);
  if (set === null) return null;

  const named = values
    .map((value) => set.members.find((member) => member.value === value)?.name)
    .filter((name): name is string => name !== undefined)
    .map((name) => readableName(name));
  return named.length === 0 ? null : named.join(", ");
}

interface DecisionShape {
  readonly subject: string;
  readonly enclosingFunction: string | null;
  readonly branches: readonly {
    readonly test: string;
    readonly values: readonly (string | number)[];
    readonly outcome: string;
    readonly touches?: readonly string[];
  }[];
}


function cell(text: unknown): string {
  return String(text ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  if (rows.length === 0) return "";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function mermaid(source: string): string {
  return source.trim() === "" ? "" : ["```mermaid", source, "```"].join("\n");
}

/**
 * Whether any reader supplied records of a kind.
 *
 * Not how many. `capability_results` holds one row per provider *and*
 * language, each carrying that provider's whole count for the kind, so
 * summing the column counts the same records several times over — a number
 * stated to a reader that no row in the knowledge base supports.
 */
function anyRead(coverage: Coverage | undefined): boolean {
  return (coverage?.outcomes ?? []).some((outcome) => outcome.recordCount > 0);
}

/**
 * How to read an empty list — the project has none, or nobody looked.
 *
 * When the readers did supply records of that kind, their standing limits are
 * not the explanation and printing them implies otherwise.
 */
function coverageLine(coverage: Coverage | undefined, subject: string): string {
  if (coverage === undefined) return "";
  if (!coverage.attempted) {
    return `No reader in this run looked for ${subject}, so nothing here says whether the project has any.`;
  }
  if (anyRead(coverage)) {
    return `${subject[0]!.toUpperCase()}${subject.slice(1)} were read, but none of them belong here.`;
  }

  // The language is part of the answer. A PHP project told what a Go struct
  // reader cannot do is being shown a true statement about the wrong stack.
  const reasons = coverage.outcomes
    .filter((outcome) => outcome.reason !== null)
    .map((outcome) =>
      outcome.language === "*"
        ? `${outcome.providerId}: ${outcome.reason!}`
        : `${outcome.providerId} (${outcome.language}): ${outcome.reason!}`,
    );
  return reasons.length === 0
    ? `Nothing was found, by readers that did look for ${subject}.`
    : "Nothing was found. What the readers said they cannot do:\n\n" +
        reasons.map((reason) => `- ${reason}`).join("\n");
}

const FRAGMENTS: Readonly<Record<string, Fragment>> = {

  "project-map": (input) => {
    const f = input.frame ?? FRAME_EN;
    const context = pick<RunContext | null>(input, "run-context");
    const edges = pick<readonly MapEdge[]>(input, "map-edges") ?? [];
    const parts = [mermaid(context?.mapDiagram ?? "")];
    if (edges.length > 0) {
      parts.push(
        table(
          [t(f, "col-from"), t(f, "col-to"), t(f, "col-kind"), t(f, "col-detail")],
          edges.map((edge) => [edge.from, edge.to, edge.kind, edge.detail]),
        ),
      );
    }
    return parts.filter((part) => part !== "").join("\n\n");
  },












  /** What the system talks to outside itself, minus what is not an integration. */
  "external-systems": (input) => {
    const f = input.frame ?? FRAME_EN;
    const edges = pick<readonly MapEdge[]>(input, "map-edges") ?? [];
    const external = edges.filter((edge) => edge.kind === "external");
    if (external.length === 0) return "";

    const real = new Map<string, Set<string>>();
    let dropped = 0;
    for (const edge of external) {
      if (NOT_AN_INTEGRATION.test(edge.to) || isPlaceholderHost(edge.to)) {
        dropped += 1;
        continue;
      }
      const callers = real.get(edge.to) ?? new Set<string>();
      callers.add(edge.from);
      real.set(edge.to, callers);
    }

    const lines = [...real.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([host, callers]) =>
          `- **${host}** — ${t(f, "reached-from", [...callers].sort().join(", "))}`,
      );

    if (dropped > 0) {
      // Named rather than silently filtered: a reader deciding on this list
      // should know it is not everything the code mentions.
      lines.push("", t(f, dropped === 1 ? "address-left-out" : "addresses-left-out", dropped));
    }
    return lines.join("\n");
  },

  /** The kinds of thing the system keeps, without naming a single table. */
  "stored-kinds": (input) => {
    const f = input.frame ?? FRAME_EN;
    const entities = pick<readonly { name: string; rootName: string }[]>(input, "entities") ?? [];
    if (entities.length === 0) {
      return coverageLine(pick<Coverage>(input, "coverage:entity"), "table declarations");
    }

    // The name a project gives a table is usually the name of the thing —
    // `wcp_leave_detail` is a leave detail. Stripping the project's own
    // prefix and the underscores leaves the noun a reader recognises.
    const words = new Map<string, number>();
    for (const entity of entities) {
      const readable = entity.name
        .replace(/^[a-z]{2,4}_/i, "")
        .replaceAll(/[_-]+/g, " ")
        .trim();
      if (readable === "") continue;
      words.set(readable, (words.get(readable) ?? 0) + 1);
    }

    const named = [...words.keys()].sort();
    const shown = named.slice(0, 24).join(", ");
    const names = named.length > 24 ? `${shown}, ${t(f, "and-more", named.length - 24)}` : shown;
    return [
      t(f, "keeps-records", entities.length, names),
      "",
      t(f, "full-schema-note"),
    ].join("\n");
  },

  /**
   * The choices the code makes, drawn.
   *
   * Only decisions with a subject every branch agrees on: those are one
   * question with several answers, which is what a diagram can show honestly.
   * A chain of unrelated guards is a sequence, not a choice, and drawing it
   * as one would invent a structure the code does not have.
   */
  "decision-diagrams": (input) => {
    const f = input.frame ?? FRAME_EN;
    const decisions = pick<readonly DecisionShape[]>(input, "feature-decisions") ?? [];
    const sets = pick<readonly ValueSet[]>(input, "value-sets") ?? [];

    // A decision is worth drawing when something is known about where its
    // branches lead. One where every branch reads "not established" tells a
    // reader the choice exists and nothing about why it matters — which is
    // worse than a sentence, because it looks like an answer.
    const worth = decisions
      .filter(
        (decision) =>
          decision.subject !== "" &&
          decision.branches.length > 1 &&
          decision.branches.some(
            (branch) => (branch.touches ?? []).length > 0 || branch.outcome === "leaves",
          ),
      )
      .sort((a, b) => b.branches.length - a.branches.length)
      .slice(0, 6);
    if (worth.length === 0) return "";

    return worth
      .map((decision) => {
        const where =
          decision.enclosingFunction === null
            ? ""
            : t(f, "while", readableName(decision.enclosingFunction));
        const lines = ["flowchart TD", `  q["${escapeLabel(readableName(decision.subject))}?"]`];

        // Branches that end the same way are drawn as one. Ten arrows to ten
        // identical boxes is a picture of the code's shape, not of what it
        // decides — the reader wants the answers grouped by what they lead to.
        const byOutcome = new Map<string, string[]>();
        for (const branch of decision.branches) {
          const named = nameValues(branch.values, decision.subject, sets);
          const label =
            branch.test === "otherwise" ? t(f, "anything-else") : (named ?? readableValue(branch.test));

          const touches = branch.touches ?? [];
          let outcome: string;
          if (touches.length > 0) {
            const shownTouches = touches.slice(0, 3).map(readableValue).join(", ");
            const list =
              touches.length > 3 ? `${shownTouches}, ${t(f, "and-more", touches.length - 3)}` : shownTouches;
            outcome = branch.outcome === "leaves" ? t(f, "stops-having-used", list) : t(f, "uses", list);
          } else {
            outcome = branch.outcome === "leaves" ? t(f, "stops-here") : t(f, "handled-unknown");
          }

          byOutcome.set(outcome, [...(byOutcome.get(outcome) ?? []), label]);
        }

        let n = 0;
        for (const [outcome, labels] of byOutcome) {
          const id = `b${n++}`;
          const shown = labels.slice(0, 6).join(", ");
          const label = `${shown}${labels.length > 6 ? `, ${t(f, "and-more", labels.length - 6)}` : ""}`;
          lines.push(`  ${id}["${escapeLabel(outcome)}"]`);
          lines.push(`  q -->|"${escapeLabel(label.slice(0, 90))}"| ${id}`);
        }

        return [`**${readableName(decision.subject)}**${where}`, mermaid(lines.join("\n"))].join("\n\n");
      })
      .join("\n\n");
  },

  /** What one capability keeps, without naming a table. */
  "capability-data": (input) => {
    const f = input.frame ?? FRAME_EN;
    const detail = pick<{ feature: FeatureFact } | null>(input, "feature-detail");
    if (!detail) return "";

    const tables = detail.feature.tables;
    const nearby = detail.feature.tablesNearby;
    if (tables.length === 0 && nearby.length === 0) {
      return coverageLine(pick<Coverage>(input, "coverage:entity"), "table declarations");
    }

    const readable = (names: readonly string[]): string =>
      [...new Set(names.map((name) => name.replace(/^[a-z]{2,4}_/i, "").replaceAll(/[_-]+/g, " ")))]
        .sort()
        .join(", ");

    const parts: string[] = [];
    if (tables.length > 0) {
      parts.push(t(f, "own-handling", readable(tables)));
    }
    if (nearby.length > 0) {
      // Weaker evidence, and saying which is which is the difference between
      // "this capability touches forty things" and what was actually seen.
      parts.push(t(f, "further-nearby", nearby.length, readable(nearby)));
    }
    return parts.join("\n\n");
  },

  limitations: (input) => {
    const f = input.frame ?? FRAME_EN;
    const notes = pick<readonly CoverageNote[]>(input, "coverage-notes") ?? [];
    const failures =
      pick<readonly { providerId: string; scope: string; reason: string }[]>(
        input,
        "extraction-failures",
      ) ?? [];

    const parts: string[] = [];
    if (notes.length > 0) {
      parts.push(
        table(
          [t(f, "col-about"), t(f, "col-cannot-establish")],
          notes.map((note) => [note.subject, note.note]),
        ),
      );
    }
    if (failures.length > 0) {
      // The same limitation repeats once per file — forty screens each noting
      // that their path mirrors a component. Grouped by what went wrong, a
      // reader sees each kind once, with a count and a few examples, rather
      // than a page of near-identical rows. The count keeps it honest: nothing
      // is dropped, it is summarised.
      const groups = new Map<
        string,
        { providerId: string; reason: string; where: string[] }
      >();
      // Most reasons open with the specific path they are about —
      // `"/leaves" registers a mount…`, `"/auth/SignIn" mirrors a component…`.
      // That path is already the row's location, so it is dropped for grouping
      // and from the shown reason, leaving one line per kind of problem.
      const generalise = (reason: string): string => reason.replace(/^"[^"]*"\s*/, "").trim();
      for (const failure of failures) {
        const reason = generalise(failure.reason);
        const key = `${failure.providerId} ${reason}`;
        const group = groups.get(key) ?? {
          providerId: failure.providerId,
          reason,
          where: [],
        };
        group.where.push(failure.scope);
        groups.set(key, group);
      }
      const rows = [...groups.values()]
        .sort((a, b) => b.where.length - a.where.length)
        .map((group) => {
          const shown = group.where.slice(0, 3).join(", ");
          const where =
            group.where.length > 3
              ? `${shown}, ${t(f, "and-more", group.where.length - 3)}`
              : shown;
          return [group.providerId, where, group.reason];
        });
      parts.push(table([t(f, "col-reader"), t(f, "col-where"), t(f, "col-went-wrong")], rows));
    }
    return parts.length === 0 ? t(f, "no-limits") : parts.join("\n\n");
  },
};

export function fragmentNames(): readonly string[] {
  return Object.keys(FRAGMENTS).sort();
}

/** Own properties only — `toString` is not a fragment. */
export function hasFragment(name: string): boolean {
  return Object.hasOwn(FRAGMENTS, name);
}

export function renderFragment(name: string, input: FragmentInput): string {
  if (!hasFragment(name)) throw new FragmentError(name);
  return FRAGMENTS[name]!(input);
}


/**
 * Hosts a system talks to that are worth a reader's attention.
 *
 * A URL literal in a codebase is as likely to be a documentation link, a
 * localhost port or an XML namespace as an integration. Left in, they make
 * the list absurd — "this platform connects to Stack Overflow" — so they are
 * dropped, and the count of what was dropped is stated rather than hidden.
 */
const NOT_AN_INTEGRATION =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])|(\.local$)|^(www\.)?(github|stackoverflow|vuejs|reactjs|npmjs|apidocjs|code\.visualstudio|developer\.mozilla|twitter|x)\.(com|org|net)$/i;

function isPlaceholderHost(host: string): boolean {
  // `xxxx.xxx.com`, `example.com`, `your-domain.com` — a template nobody filled in.
  return /^(x+|example|test|foo|bar|your[-_]?\w*)\./i.test(host) || /\bexample\.(com|org)$/i.test(host);
}
