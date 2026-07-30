/**
 * The sections code can fill: tables, diagrams, lists.
 *
 * A fragment gets the slice its section asked for and returns Markdown. It
 * states facts and nothing else — no adjectives, no conclusions, no counts
 * dressed as judgements. Anything that needs a sentence about what the facts
 * mean is an `llm` section with a prompt someone can edit.
 */

import type { KnowledgeBase, Coverage, DimensionCoverage } from "../kb/query.js";
import type { CoverageNote, FeatureFact, MapEdge } from "../kb/facts.js";
import type {
  FeatureFlowCoverage,
  RepositoryProfile,
  StackEntry,
} from "../kb/profiles.js";
import { mapToMermaid } from "../flows/mermaid.js";
import { isRealIntegration } from "../kb/hosts.js";
import { EVERY_ROOT } from "../kb/coverage.js";
import {
  FRAME_EN,
  note as localizeNote,
  reasonWithoutPath,
  stopReason,
  t,
  type Glossary,
} from "./strings.js";

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

/**
 * `6 of 8 (75%)`, or `0 of 0` where a percentage would divide by nothing.
 *
 * Rounded down short of the whole: `Math.round` prints "(100%)" for 199 of 200,
 * and a reader who sees 100% stops looking for the one that is missing.
 */
function share(frame: Glossary, part: number, whole: number): string {
  if (whole === 0) return t(frame, "of-total", part, whole);
  const exact = (part / whole) * 100;
  const percent = part < whole ? Math.min(Math.floor(exact), 99) : Math.round(exact);
  return t(frame, "of-total-percent", part, whole, percent);
}

/**
 * `react 18.3.1`, or `react ^18.0.0✱` for a range.
 *
 * The mark rather than a word per entry: a stack line carries a dozen of
 * these, and a parenthesis on each would bury the versions themselves.
 */
/**
 * How many of a repository's libraries to name.
 *
 * Nothing in the data tells a framework from a general-purpose helper — tested
 * on WCP, `lodash` is imported by 376 files against React's 519, exposes more
 * distinct names, and sits in the same kinds of file, so no usage signal
 * separates them. Rather than guess with a curated list, the most-imported few
 * are named and the note beside the table says that is what they are.
 */
const STACK_SHOWN = 6;

function versionOf(entry: StackEntry): string {
  if (entry.version === null) return entry.name;
  return `${entry.name} ${entry.version}${entry.resolved ? "" : "✱"}`;
}

const FRAGMENTS: Readonly<Record<string, Fragment>> = {

  /**
   * What was analyzed: one row per repository, then what each is built with.
   *
   * The table holds what is comparable across repositories; the stack is a
   * line of its own because a dozen packages with versions does not fit a
   * cell a reader can scan.
   */
  repositories: (input) => {
    const f = input.frame ?? FRAME_EN;
    const profiles = pick<readonly RepositoryProfile[]>(input, "repositories") ?? [];
    if (profiles.length === 0) return "";

    const rows = profiles.map((profile) => [
      profile.rootName,
      profile.roles.length === 0
        ? t(f, "role-none")
        : profile.roles.map((role) => t(f, `role-${role}`)).join(" · "),
      profile.languages
        .slice(0, 3)
        .map((language) => `${language.name} ${language.files}`)
        .join(", "),
      share(f, profile.filesWithFacts, profile.codeFiles),
      profile.endpointCount === 0
        ? null
        : share(f, profile.tracedEndpointCount, profile.endpointCount),
      profile.endpointsWithoutCaller === 0 ? null : profile.endpointsWithoutCaller,
      profile.screenCount === 0 ? null : profile.screenCount,
      profile.testCount === 0 ? null : profile.testCount,
    ]);

    const parts = [
      table(
        [
          t(f, "col-repository"),
          t(f, "col-does"),
          t(f, "col-languages"),
          t(f, "col-files-read"),
          t(f, "col-endpoints-traced"),
          t(f, "col-no-caller"),
          t(f, "col-screens"),
          t(f, "col-tests"),
        ],
        rows,
      ),
    ];

    // The stack as a table a reader can scan down, rather than one long line
    // per repository. Six entries is what fits before a reader stops reading;
    // the rest are counted, because a dozen names in a row is the thing that
    // made this unreadable.
    const withStack = profiles.filter(
      (profile) => profile.platforms.length > 0 || profile.stack.length > 0,
    );
    if (withStack.length > 0) {
      parts.push(
        table(
          [t(f, "col-repository"), t(f, "col-runtime"), t(f, "col-built-with"), t(f, "col-dependencies")],
          withStack.map((profile) => [
            profile.rootName,
            profile.platforms.length === 0
              ? null
              : profile.platforms.map(versionOf).join(", "),
            profile.stack.slice(0, STACK_SHOWN).map(versionOf).join(", "),
            t(
              f,
              "of-total",
              profile.dependenciesWithExactVersion,
              profile.directDependencies,
            ),
          ]),
        ),
        t(f, "stack-note", STACK_SHOWN),
      );
    }

    // Migrations are counted apart from code, so a repository that has them
    // says so rather than having them silently left out of both numbers.
    const migrations = profiles
      .filter((profile) => profile.migrationFiles > 0)
      .map((profile) =>
        t(
          f,
          "migrations-read",
          profile.rootName,
          share(f, profile.migrationsWithFacts, profile.migrationFiles),
        ),
      );
    if (migrations.length > 0) parts.push(migrations.join("\n\n"));

    // A column, not a paragraph per repository: five of those recreated the
    // wall of text this section was rewritten to avoid.
    if (profiles.some((profile) => profile.endpointsWithoutCaller > 0)) {
      parts.push(t(f, "no-caller-note"));
    }

    const anyRange = profiles.some((profile) =>
      [...profile.platforms, ...profile.stack].some(
        (entry) => entry.version !== null && !entry.resolved,
      ),
    );
    if (anyRange) parts.push(t(f, "range-marked"));

    return parts.filter((part) => part !== "").join("\n\n");
  },

  /**
   * Which kinds of fact this run looked for, and what each yielded where.
   *
   * The honest companion to a coverage percentage: a reader who can see that
   * call edges were never read knows why a trace stops, instead of concluding
   * the code has no calls.
   */
  "analysis-dimensions": (input) => {
    const f = input.frame ?? FRAME_EN;
    const dimensions = pick<readonly DimensionCoverage[]>(input, "analysis-dimensions") ?? [];
    if (dimensions.length === 0) return "";

    const roots = dimensions[0]!.byRoot.map((entry) => entry.rootName);
    const supplied = [...dimensions]
      .filter((dimension) => dimension.records > 0)
      .sort((a, b) => b.records - a.records);

    const parts = [
      table(
        [t(f, "col-fact"), t(f, "col-total"), ...roots],
        supplied.map((dimension) => [
          dimension.kind,
          dimension.records,
          ...dimension.byRoot.map((entry) => (entry.records === 0 ? null : entry.records)),
        ]),
      ),
      t(f, "dimensions-note"),
    ];

    const neverAsked = dimensions.filter((dimension) => !dimension.attempted);
    if (neverAsked.length > 0) {
      parts.push(
        `${t(f, "not-looked-for")}\n\n` +
          neverAsked.map((dimension) => `- ${dimension.kind}`).join("\n"),
      );
    }

    // A kind with records in one repository and none in another: the reason it
    // found nothing *there* was collected but never shown, because this list
    // only considered kinds empty everywhere. On WCP that lost the reason
    // imports were not read in the older service.
    const emptyInSomeRoot = dimensions
      .filter((dimension) => dimension.records > 0)
      .flatMap((dimension) =>
        dimension.byRoot
          .filter((entry) => entry.records === 0 && entry.reason !== null)
          .map((entry) => `- ${dimension.kind} · ${entry.rootName} — ${localizeNote(f, entry.reason!)}`),
      );
    if (emptyInSomeRoot.length > 0) {
      parts.push(`${t(f, "empty-in-some-root")}\n\n${emptyInSomeRoot.join("\n")}`);
    }

    // Looked for and empty is a third state, and the reason a reader needs is
    // the one its readers already stated.
    const emptyWithReason = dimensions
      .filter((dimension) => dimension.attempted && dimension.records === 0)
      .map((dimension) => ({
        kind: dimension.kind,
        reasons: [
          ...new Set(
            dimension.byRoot
              .map((entry) => entry.reason)
              .filter((reason): reason is string => reason !== null),
          ),
        ],
      }));
    if (emptyWithReason.length > 0) {
      parts.push(
        `${t(f, "looked-found-none")}\n\n` +
          emptyWithReason
            .map((entry) =>
              entry.reasons.length === 0
                ? `- ${entry.kind}`
                : `- ${entry.kind} — ${entry.reasons.map((reason) => localizeNote(f, reason)).join(t(f, "join"))}`,
            )
            .join("\n"),
      );
    }

    return parts.filter((part) => part !== "").join("\n\n");
  },

  /** How much of each capability's flows was followed, across the project. */
  "flow-coverage": (input) => {
    const f = input.frame ?? FRAME_EN;
    const coverage = pick<readonly FeatureFlowCoverage[]>(input, "flow-coverage") ?? [];
    if (coverage.length === 0) return "";

    return table(
      [t(f, "col-capability"), t(f, "col-flows-traced"), t(f, "col-steps-traced")],
      coverage.map((entry) => [
        entry.featureName,
        share(f, entry.fullyTracedFlows, entry.flowCount),
        share(f, entry.resolvedSteps, entry.steps),
      ]),
    );
  },

  /**
   * The same, flow by flow, for one capability.
   *
   * Beside the diagrams it belongs to: a reader weighing a flowchart needs to
   * know it was followed to the end, and the least-complete flows come first
   * because they are the ones a claim should not rest on.
   */
  "capability-flow-coverage": (input) => {
    const f = input.frame ?? FRAME_EN;
    const coverage = pick<FeatureFlowCoverage | null>(input, "feature-flow-coverage");
    if (!coverage || coverage.flows.length === 0) return "";

    const shown = coverage.flows.slice(0, 40);
    const parts = [
      table(
        [t(f, "col-flow"), t(f, "col-steps-traced"), t(f, "col-stops-at")],
        shown.map((flow) => [
          `${flow.method ?? ""} ${flow.path}`.trim(),
          share(f, flow.resolvedSteps, flow.steps),
          flow.unresolvedReasons.length === 0
            ? null
            : flow.unresolvedReasons.map((reason) => stopReason(f, reason)).join(t(f, "join")),
        ]),
      ),
    ];

    if (coverage.flows.length > shown.length) {
      parts.push(t(f, "and-more", coverage.flows.length - shown.length));
    }
    if (coverage.fullyTracedFlows === 0) parts.push(t(f, "no-flows-traced"));

    return parts.filter((part) => part !== "").join("\n\n");
  },

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

    // The linkage a reader needs before changing this data: which of these
    // records other capabilities also touch. Computed from the same tables
    // the features already claim, so it introduces no new evidence — only
    // the join nobody would do by hand.
    const others = (pick<readonly FeatureFact[]>(input, "features") ?? []).filter(
      (candidate) => candidate.id !== detail.feature.id,
    );
    if (others.length > 0 && tables.length > 0) {
      const shared = tables
        .map((table) => ({
          table,
          by: others
            .filter((candidate) => candidate.tables.includes(table))
            .map((candidate) => candidate.name)
            .sort(),
        }))
        .filter((entry) => entry.by.length > 0);
      if (shared.length > 0) {
        const listed = shared
          .slice(0, 8)
          .map((entry) => `${readable([entry.table])} (${entry.by.join(", ")})`)
          .join("; ");
        const suffix =
          shared.length > 8 ? `; ${t(f, "and-more", shared.length - 8)}` : "";
        parts.push(t(f, "shared-tables", `${listed}${suffix}`));
      }
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
          notes.map((entry) => [
            // The subject is `kind · where`, and `where` may be the engine's
            // own word for "everywhere" rather than a list of root names.
            entry.subject.replace(EVERY_ROOT, t(f, "every-root")),
            localizeNote(f, entry.note),
          ]),
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
      for (const failure of failures) {
        const reason = reasonWithoutPath(failure.reason);
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
          return [group.providerId, where, localizeNote(f, group.reason)];
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


