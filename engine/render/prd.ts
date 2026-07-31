/**
 * The recovered specification's own sections.
 *
 * Its own module because `fragments.ts` was 1,235 lines against a 500-line working
 * ceiling, and every issue in the queue touches it. Nothing here is new: the split
 * is a move, and these fragments read exactly as they did in the registry.
 *
 * One exception in this file is deliberate: `prd-not-recoverable` is fixed prose.
 * What cannot be recovered from any codebase is a property of the method rather than
 * of a project, so it is the same in every document — and a sentence that must never
 * vary is safer as a fragment than as a prompt a writer could soften.
 */

import type { CoverageNote, FeatureFact, FeatureFlowFact } from "../kb/facts.js";
import type { RouteRecord } from "../structural/boundaries.js";
import type {
  SilentFile,
} from "../kb/profiles.js";
import {
  FRAME_EN,
  t,
  type Glossary,
} from "./strings.js";

import {
  mermaid,
  pick,
  table,
  type Fragment,
} from "./parts.js";
import { VALIDATION_FRAGMENTS } from "./rules-section.js";

/** How many addresses to list per area before summarising. */
const PAGES_PER_AREA = 6;


/** Capabilities whose flows are drawn, and flows drawn for each: a diagram is a page. */
const FEATURES_WITH_FLOWS = 8;

const FLOWS_PER_FEATURE = 2;

/** How many of a capability's addresses to name before summarising. */
const ENDPOINTS_PER_FEATURE = 8;

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

export const PRD_FRAGMENTS: Readonly<Record<string, Fragment>> = {
  ...VALIDATION_FRAGMENTS,
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

};
