/**
 * The sections code can fill: tables, diagrams, lists.
 *
 * A fragment gets the slice its section asked for and returns Markdown. It
 * states facts and nothing else — no adjectives, no conclusions, no counts
 * dressed as judgements. Anything that needs a sentence about what the facts
 * mean is an `llm` section with a prompt someone can edit.
 */

import type { KnowledgeBase, Coverage } from "../kb/query.js";
import type { CoverageNote, FeatureFact, MapEdge } from "../kb/facts.js";
import { mapToMermaid } from "../flows/mermaid.js";
import { isRealIntegration } from "../kb/hosts.js";
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
    const all = pick<readonly MapEdge[]>(input, "map-edges") ?? [];
    // A localhost port or an unfilled `xxxx.xxx.com` template is not a system
    // the platform talks to. Filtered here as well as at the KB's map so an
    // older knowledge base, built before the filter, still draws a clean map.
    const edges = all.filter(
      (edge) => edge.kind !== "external" || isRealIntegration(edge.to),
    );
    const parts = [mermaid(mapToMermaid(edges))];
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
      if (!isRealIntegration(edge.to)) {
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


