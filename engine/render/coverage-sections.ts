/**
 * How much of the project each reader reached, and what each dimension yielded.
 *
 * Its own module for the same reason the recovered specification has one: the
 * registry was 1,235 lines against a 500-line ceiling. A move, not a rewrite.
 */

import type { DimensionCoverage } from "../kb/query.js";
import type { FeatureFlowCoverage } from "../kb/profiles.js";
import { FRAME_EN, note as localizeNote, t } from "./strings.js";
import { pick, share, table, type Fragment } from "./parts.js";

export const COVERAGE_FRAGMENTS: Readonly<Record<string, Fragment>> = {
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

};
