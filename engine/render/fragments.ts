/**
 * The sections code can fill: tables, diagrams, lists.
 *
 * A fragment gets the slice its section asked for and returns Markdown. It
 * states facts and nothing else — no adjectives, no conclusions, no counts
 * dressed as judgements. Anything that needs a sentence about what the facts
 * mean is an `llm` section with a prompt someone can edit.
 *
 * One exception, and it is deliberate: `prd-not-recoverable` is fixed prose. What
 * cannot be recovered from any codebase is a property of the method rather than
 * of a project, so it is the same in every document — and a sentence that must
 * never vary is safer as a fragment than as a prompt a writer could soften.
 */

import type { KnowledgeBase, Coverage, DimensionCoverage } from "../kb/query.js";
import type { CoverageNote, FeatureFact, FeatureFlowFact, MapEdge } from "../kb/facts.js";
import type { GuardRecord } from "../structural/rules.js";
import type { RouteRecord } from "../structural/boundaries.js";
import type {
  FeatureFlowCoverage,
  RepositoryProfile,
  SilentFile,
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
  // An empty string is absence too, and it rendered as a blank cell where every
  // other absence in these documents reads as a dash.
  const value = text === null || text === undefined || text === "" ? "—" : String(text);
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * How many silent files a section names per repository.
 *
 * Per repository, not overall, because a global top-N is decided by the biggest
 * repository: on a five-root workspace, 22 of 25 rows came from the front end and
 * two repositories were named nowhere at all — including the one whose model
 * files declare the schema the report describes. The issue asked for a
 * per-repository view, and a global sort is not one.
 *
 * Enough to be useful on a real repository, few enough that this does not become
 * the longest section in the report. What is dropped is counted, so a truncated
 * list never reads as a complete one.
 */
const SILENT_PER_ROOT = 8;

/** A file's size in the unit a reader can weigh, rather than raw bytes. */
function fileSize(frame: Glossary, bytes: number): string {
  return bytes >= 1024 ? t(frame, "kib", Math.round(bytes / 1024)) : t(frame, "bytes", bytes);
}

/**
 * The shared body of the two silence sections.
 *
 * Split by scope rather than branching inside one fragment, the same way flow
 * coverage is: a fragment must read only the selectors its section declared, and
 * a guard test enforces that.
 *
 * Two groups, because there are two facts and conflating them was wrong in both
 * directions. A **silent** file was read and says nothing about behaviour. An
 * **unread** file produced nothing at all, so whether it holds behaviour is
 * unknown rather than absent — a stronger statement, and the one that matters
 * most when the file is a model declaring a table. Putting the second group in
 * the first led the list with a file that is entirely commented out; leaving it
 * out altogether hid forty-one model files.
 *
 * Grouped by repository within each, so every repository with something to say
 * gets named however large its neighbours are.
 */
function silence(
  input: FragmentInput,
  silent: readonly SilentFile[] | undefined,
  unread: readonly SilentFile[] | undefined,
  emptyKey: string,
): string {
  const f = input.frame ?? FRAME_EN;
  if (silent === undefined) return "";
  if (silent.length === 0 && (unread ?? []).length === 0) return t(f, emptyKey);

  const parts: string[] = [];
  if (silent.length > 0) {
    parts.push(t(f, "silent-lead"), ...groupedByRoot(f, silent));
  }
  if ((unread ?? []).length > 0) {
    parts.push(t(f, "unread-lead"), ...groupedByRoot(f, unread!));
  }
  parts.push(t(f, "silent-note"));
  return parts.join("\n\n");
}

/** One table per repository, each ordered by size and truncated on its own. */
function groupedByRoot(f: Glossary, files: readonly SilentFile[]): string[] {
  const byRoot = new Map<string, SilentFile[]>();
  for (const file of files) {
    const group = byRoot.get(file.rootName) ?? [];
    group.push(file);
    byRoot.set(file.rootName, group);
  }

  const parts: string[] = [];
  const single = byRoot.size === 1;
  for (const [rootName, group] of [...byRoot.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    // One repository needs no heading — the paths already say which it is.
    if (!single) parts.push(t(f, "silent-in", rootName));
    const shown = group.slice(0, SILENT_PER_ROOT);
    parts.push(
      table(
        [t(f, "col-file"), t(f, "col-size")],
        shown.map((file) => [
          single ? `${file.rootName}/${file.relPath}` : file.relPath,
          fileSize(f, file.sizeBytes),
        ]),
      ),
    );
    if (group.length > shown.length) parts.push(t(f, "and-more", group.length - shown.length));
  }
  return parts;
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

/** How many addresses to list per area before summarising. */
const PAGES_PER_AREA = 6;

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

/** Conditions shown per rule before the rest are counted. */
const TESTS_PER_RULE = 2;

/**
 * What a capability's files touch, and what its package touches beside them.
 *
 * Two scopes, never merged: a table read in the handler's own file is closer to
 * this capability than one read somewhere else in its package, and printing them
 * alike would widen a cell that is already wider than the capability.
 */
function tableCell(
  f: Glossary,
  own: readonly string[],
  nearby: readonly string[],
  truncated: boolean,
): string | null {
  const listed = (names: readonly string[]): string => {
    const shown = names.slice(0, TABLES_PER_FEATURE);
    const rest = names.length - shown.length;
    return shown.join(", ") + (rest > 0 ? `, ${t(f, "and-more", rest)}` : "");
  };

  const parts: string[] = [];
  if (own.length > 0) parts.push(listed(own));
  if (nearby.length > 0) parts.push(t(f, "tables-in-package", listed(nearby)));
  // Two caps compound here: this one, and the assembler's per-flow cap, whose
  // remainder no number can honestly state — the same unnamed table may sit behind
  // several endpoints. Eleven capabilities printed twelve tables and said nothing,
  // while their own diagrams three pages later read "16 more tables".
  if (truncated && parts.length > 0) parts.push(t(f, "tables-not-counted"));
  return parts.length === 0 ? null : parts.join("<br>");
}

/** Tables named per scope before the rest are counted: Employee has 45 nearby. */
const TABLES_PER_FEATURE = 12;

/** Endpoints named individually where no capability claimed them. */
const ORPHAN_ENDPOINTS = 80;

/** Capabilities whose flows are drawn, and flows drawn for each: a diagram is a page. */
const FEATURES_WITH_FLOWS = 8;
const FLOWS_PER_FEATURE = 2;

/** Steps attributed to the handler's package rather than to the handler itself. */
function vagueSteps(flow: FeatureFlowFact): number {
  return flow.steps.filter((step) => step.indirect === true).length;
}

/** How many of a capability's flows closed, which is what "traced" has to mean. */
function flowTally(f: Glossary, flows: readonly FeatureFlowFact[]): string {
  const partial = flows.filter((flow) => flow.partial).length;
  return partial === 0
    ? t(f, "prd-flow-whole", flows.length)
    : t(f, "prd-flow-partial", partial, flows.length);
}

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

/** How many of a capability's addresses to name before summarising. */
const ENDPOINTS_PER_FEATURE = 8;

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

  /**
   * How work actually moves: the traced flows themselves, a few per capability.
   *
   * The section was filled with `flow-coverage`, which states how much of each
   * capability's flows the analysis followed — two numbers about the analysis,
   * under a heading promising the system's behaviour, in a document that already
   * has a section for what the analysis could not do.
   *
   * Drawn per flow rather than per capability. A capability's overview chart puts
   * every endpoint and table on one canvas, which for WCP's Review capability is
   * 222 nodes joined by 14 edges: a reader sees a wall of names and almost no
   * movement, and the section came to 2,068 lines of a 3,270-line document. One
   * flow is an entry point and the steps it reaches, which is what movement is.
   *
   * Flows with every step established come first, because a reader comparing two
   * capabilities should meet a complete trace before a partial one.
   */
  "prd-flows": (input) => {
    const f = input.frame ?? FRAME_EN;
    const flows = pick<readonly FeatureFlowFact[]>(input, "flows") ?? [];
    const features = pick<readonly FeatureFact[]>(input, "features") ?? [];
    if (flows.length === 0) return t(f, "prd-no-flows");

    const nameOf = new Map(features.map((feature) => [feature.id, feature.name]));
    const byFeature = new Map<string, FeatureFlowFact[]>();
    for (const flow of flows) {
      byFeature.set(flow.featureId, [...(byFeature.get(flow.featureId) ?? []), flow]);
    }

    let drawn = 0;
    const shown: FeatureFlowFact[] = [];

    const body: string[] = [];
    const ordered = [...byFeature.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "en"),
    );
    for (const [featureId, own] of ordered.slice(0, FEATURES_WITH_FLOWS)) {
      // Clearest first: a trace that closes, and whose steps were observed in the
      // handler rather than somewhere in its package. Without the second term the
      // section opened on a delete endpoint drawn against 13 tables, every edge
      // dotted and labelled "observed in the handler's package" — honest, and no
      // picture of anything. How many flows are not drawn is stated below.
      const show = [...own]
        .sort(
          (a, b) =>
            Number(a.partial) - Number(b.partial) ||
            vagueSteps(a) - vagueSteps(b) ||
            a.steps.length - b.steps.length ||
            // Pinned, like every other ordering here: unpinned, two machines with
            // different locales draw different flows from the same knowledge base.
            a.entryKey.localeCompare(b.entryKey, "en"),
        )
        .slice(0, FLOWS_PER_FEATURE);
      body.push(`**${nameOf.get(featureId) ?? featureId}** — ${flowTally(f, own)}`);
      for (const flow of show) {
        body.push(`${t(f, "prd-flow-entry", flow.entryKey)}`, mermaid(flow.diagram));
        shown.push(flow);
        drawn += 1;
      }
    }
    // Measured, not asserted. Both sentences named a property of what was drawn —
    // that every one has no gap, that most rest partly on package evidence — and
    // neither was computed, so each was true of one target and unchecked anywhere.
    const withGap = shown.filter((flow) => flow.partial).length;
    const withPackageEvidence = shown.filter((flow) => vagueSteps(flow) > 0).length;
    const parts = [
      t(
        f,
        "prd-flows-lead",
        shown.length,
        withGap === 0 ? t(f, "prd-flows-all-whole") : t(f, "prd-flows-some-partial", withGap),
        withPackageEvidence,
      ),
      ...body,
    ];
    if (flows.length > drawn) {
      parts.push(t(f, "prd-flows-left-out", flows.length - drawn, flows.length, FLOWS_PER_FEATURE));
    }
    // The bound on capabilities was never stated, so 28 of WCP's 36 capabilities
    // with traced flows vanished from a section whose lead reads as covering all
    // of them. Their flows were inside a total; the capabilities were nowhere.
    if (byFeature.size > FEATURES_WITH_FLOWS) {
      parts.push(
        t(f, "prd-flows-capabilities-left-out", byFeature.size - FEATURES_WITH_FLOWS, byFeature.size),
      );
    }

    // Two different silences, and stating one reason for both was wrong for every
    // capability it described: all 12 of WCP's flowless capabilities have no
    // endpoint at all, so nothing was ever there to trace from.
    const flowless = features.filter((feature) => !byFeature.has(feature.id));
    const noEntry = flowless.filter((feature) => feature.endpoints.length === 0).length;
    const noChain = flowless.length - noEntry;
    if (noEntry > 0) parts.push(t(f, "prd-flows-no-entry", noEntry, features.length));
    if (noChain > 0) parts.push(t(f, "prd-flows-no-chain", noChain, features.length));
    return parts.join("\n\n");
  },

  /**
   * The feature list, one row per capability the analysis detected.
   *
   * Identifiers are `F001…` because that is what the receiving format uses, and
   * they are assigned here rather than carried in the facts: whether a producer
   * mints them is unsettled (57B-277), so they are a rendering decision that can
   * be swapped without touching a single extracted record.
   *
   * Ordered by endpoint count, so the largest surface reads first. What each row
   * cannot say is priority — no ranking survives in source, and inventing one
   * would put a product decision in a recovered document.
   */
  "prd-features": (input) => {
    const f = input.frame ?? FRAME_EN;
    const endpoints = pick<readonly RouteRecord[]>(input, "endpoints") ?? [];
    const features = pick<readonly FeatureFact[]>(input, "features") ?? [];
    if (features.length === 0) return t(f, "prd-no-features");

    // By endpoint count, and by name where two tie. `localeCompare` is pinned to
    // one locale: unpinned it orders "Ärende" before "Order" on an English
    // machine and after it on a Swedish one, so the same code would produce
    // different identifiers on two developers' laptops.
    const ranked = [...features].sort(
      (a, b) => b.endpoints.length - a.endpoints.length || a.name.localeCompare(b.name, "en"),
    );

    const rows = ranked.map((feature, index) => {
      // Keyed by service as well as address, and shown with it. Dropping the
      // service made a count and a list disagree — Support says 21 endpoints and
      // listed 19 — and lost the fact a rebuild most needs, that
      // `GET /v2/support/projects` is served by two services at once.
      const paths = [
        ...new Set(feature.endpoints.map((e) => `${e.rootName}: ${e.method ?? "ANY"} ${e.path}`)),
      ].sort();
      const shown = paths.slice(0, ENDPOINTS_PER_FEATURE);
      const tables = [...new Set(feature.tables)].sort();
      // Tables observed in the handler's package rather than its file. Without
      // these, 24 of 38 dashes stood for 1 to 45 attributed tables, and the flows
      // section drew Billing's seven tables three pages after Billing's row said
      // none could be attributed at all.
      const nearby = [...new Set(feature.tablesNearby)].sort().filter((name) => !tables.includes(name));
      return [
        `F${String(index + 1).padStart(3, "0")}`,
        feature.name,
        feature.endpoints.length === 0 ? null : feature.endpoints.length,
        shown.join("<br>") +
          (paths.length > shown.length ? `<br>${t(f, "and-more", paths.length - shown.length)}` : ""),
        tableCell(f, tables, nearby, feature.tablesTruncated),
      ];
    });

    // Endpoints no capability claimed. Left out entirely, 65 of WCP's 539 endpoints
    // — `POST /projects`, `POST /file/upload`, `POST /cronjobs` among them —
    // appeared nowhere in a document meant to be built from, while a note said
    // they were "listed only under their service", which is a section the overview
    // has and this document does not.
    const claimed = new Set(
      features.flatMap((feature) =>
        feature.endpoints.map((e) => `${e.rootName}:${e.method ?? "ANY"} ${e.path}`),
      ),
    );
    const orphans = endpoints
      .filter((route) => !claimed.has(`${route.rootName}:${route.method ?? "ANY"} ${route.path}`))
      .map((route) => `${route.rootName}: ${route.method ?? "ANY"} ${route.path}`)
      .sort();

    const parts = [
      t(f, "prd-features-lead"),
      table(
        [
          t(f, "col-id"),
          t(f, "col-capability"),
          t(f, "col-endpoints"),
          t(f, "col-addresses"),
          t(f, "col-tables-touched"),
        ],
        rows,
      ),
    ];
    if (orphans.length > 0) {
      const shown = orphans.slice(0, ORPHAN_ENDPOINTS);
      parts.push(t(f, "prd-orphan-endpoints", orphans.length, endpoints.length));
      parts.push(shown.map((address) => `- \`${address}\``).join("\n"));
      if (orphans.length > shown.length) {
        parts.push(t(f, "and-more", orphans.length - shown.length));
      }
    }
    parts.push(t(f, "prd-features-note"));
    return parts.join("\n\n");
  },

  /**
   * The page map: the application's own addresses, as read from its route table.
   *
   * Grouped by first path segment, which is how these applications are organised
   * and how a reader navigates them. The hierarchy is the paths' own — a nested
   * path is a nested page — and route parameters are left as the code writes them
   * so `:id` reads as a parameter rather than a literal.
   *
   * What this cannot say is stated rather than guessed: no page is joined to the
   * component that draws it on this evidence, so page goal, key action and
   * completion criteria are absent by necessity, not oversight.
   */
  "prd-pages": (input) => {
    const f = input.frame ?? FRAME_EN;
    const screens = pick<readonly RouteRecord[]>(input, "screens") ?? [];
    if (screens.length === 0) return t(f, "prd-no-pages");

    // By root first. Grouping on the path alone merged two front ends into one
    // table and counted a duplicate address twice — the same failure the silence
    // section already paid for, where one repository crowded out four others.
    const byRoot = new Map<string, RouteRecord[]>();
    for (const screen of screens) {
      const group = byRoot.get(screen.rootName) ?? [];
      group.push(screen);
      byRoot.set(screen.rootName, group);
    }

    const parts = [t(f, "prd-pages-lead", screens.length)];
    const single = byRoot.size === 1;
    for (const [rootName, group] of [...byRoot.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "en"),
    )) {
      if (!single) parts.push(t(f, "silent-in", rootName));

      // Two segments deep, because one put 132 of 182 addresses under `/manage`
      // and listed six of them. An area a reader can navigate is `/manage/leave`,
      // not `/manage`.
      const byArea = new Map<string, Set<string>>();
      for (const screen of group) {
        const segments = screen.path.split("/").filter(Boolean);
        const area = segments.length === 0 ? "/" : `/${segments.slice(0, 2).join("/")}`;
        const paths = byArea.get(area) ?? new Set<string>();
        paths.add(screen.path);
        byArea.set(area, paths);
      }

      const rows = [...byArea.entries()]
        .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "en"))
        .map(([area, paths]) => {
          const sorted = [...paths].sort();
          const shown = sorted.slice(0, PAGES_PER_AREA);
          return [
            area,
            sorted.length,
            shown.join(", ") +
              (sorted.length > shown.length
                ? `, ${t(f, "and-more", sorted.length - shown.length)}`
                : ""),
          ];
        });
      parts.push(table([t(f, "col-area"), t(f, "col-pages"), t(f, "col-addresses")], rows));
    }

    parts.push(t(f, "prd-pages-note"));
    return parts.join("\n\n");
  },

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

  /**
   * What this document cannot say, and why — stated rather than left blank.
   *
   * A recovered specification is structurally complete and intent-empty: it
   * states in mechanical detail what the system does, and cannot state why any
   * of it was built or which parts matter. Leaving those sections absent invites
   * a reader to assume the recovery failed, or worse, that the system has no
   * goals. Naming them is what makes the document honest enough to build from.
   *
   * Also inverts one section deliberately. Read forwards, "out of scope" is a
   * decision somebody made. Read backwards, everything in the code is in scope by
   * definition, so the only honest content is what could not be read.
   */
  "prd-not-recoverable": (input) => {
    const f = input.frame ?? FRAME_EN;
    const silent = pick<readonly SilentFile[]>(input, "silent-files") ?? [];
    const unread = pick<readonly SilentFile[]>(input, "unread-files") ?? [];
    const notes = pick<readonly CoverageNote[]>(input, "coverage-notes") ?? [];

    const parts = [t(f, "prd-absent-lead")];
    parts.push(
      [
        t(f, "prd-absent-goal"),
        t(f, "prd-absent-users"),
        t(f, "prd-absent-metrics"),
        t(f, "prd-absent-priority"),
        t(f, "prd-absent-risks"),
      ]
        .map((line) => `- ${line}`)
        .join("\n"),
    );
    parts.push(t(f, "prd-absent-scope"));
    if (silent.length + unread.length > 0) {
      parts.push(t(f, "prd-absent-counts", silent.length, unread.length));
    }
    if (notes.length > 0) {
      parts.push(t(f, "prd-absent-notes", notes.length));
    }
    return parts.join("\n\n");
  },

  /**
   * Where this report stopped reading, named file by file.
   *
   * The counterpart to a coverage percentage. A fraction says how much was read;
   * this says which parts yielded nothing, so a reader can open one rather than
   * infer from silence that there was nothing to find. A capability report once
   * said nothing whatever about a file holding an entire leave policy, and a
   * reader reasonably concluded the file was uninteresting.
   *
   * A code section deliberately, not prose: the list is facts, and a writer asked
   * to describe it would be tempted to guess what is inside the files.
   */
  "silent-files": (input) =>
    silence(
      input,
      pick<readonly SilentFile[]>(input, "silent-files"),
      pick<readonly SilentFile[]>(input, "unread-files"),
      "silent-none-repo",
    ),

  /** The same, for one capability's own files. */
  "capability-silent-files": (input) =>
    silence(
      input,
      pick<readonly SilentFile[]>(input, "feature-silent-files"),
      pick<readonly SilentFile[]>(input, "feature-unread-files"),
      "silent-none",
    ),
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


