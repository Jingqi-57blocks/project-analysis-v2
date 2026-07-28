/**
 * Measures what the providers actually supply against what the model defines.
 *
 * Indexed is not understood: a provider supporting a language says nothing
 * about whether it resolves that language's frameworks, permission models,
 * ORM access, or dynamic calls. Treating language support as proof of coverage
 * is how a tool ends up confidently reporting an incomplete picture.
 *
 * Built from declared capabilities and observed record counts rather than from
 * prose, so the matrix cannot drift away from what the code does.
 */

import { STRUCTURAL_KINDS, isUniversalKind, type StructuralKind } from "./kinds.js";
import { ANY_LANGUAGE, type CapabilityGap, type ProviderCapabilities, type StructuralContribution } from "./provider.js";

export type CoverageLevel = "full" | "partial" | "absent" | "unclaimed";

export interface CoverageCell {
  readonly kind: StructuralKind;
  readonly providerId: string;
  readonly language: string;
  readonly level: CoverageLevel;
  readonly recordCount: number;
  readonly limits: readonly string[];
  /** Set when a gap was reported for this kind during the run. */
  readonly gapReason: string | null;
}

export interface KindCoverage {
  readonly kind: StructuralKind;
  /** True when at least one provider claims and produced something. */
  readonly covered: boolean;
  readonly totalRecords: number;
  readonly cells: readonly CoverageCell[];
  /**
   * Whether an empty result should read as a finding. Universal kinds coming
   * back empty suggest a gap; conditional kinds legitimately have nothing.
   */
  readonly emptyIsSuspicious: boolean;
}

export interface CoverageMatrix {
  readonly kinds: readonly KindCoverage[];
  /** Kinds the model defines that nobody claimed at all. */
  readonly unclaimedKinds: readonly StructuralKind[];
}

export interface ProviderReport {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  readonly contribution: StructuralContribution;
}

/**
 * Matched on language too. A polyglot repository can report several gaps for
 * one kind — an unreadable Podfile and an unreadable build.gradle both produce
 * a package-dependency gap — and matching on kind alone would show the first
 * and silently drop the rest from the matrix.
 */
function gapFor(
  gaps: readonly CapabilityGap[],
  kind: StructuralKind,
  language: string,
): CapabilityGap | undefined {
  return (
    gaps.find((gap) => gap.kind === kind && gap.language === language) ??
    gaps.find((gap) => gap.kind === kind && gap.language === ANY_LANGUAGE)
  );
}

export function buildCoverageMatrix(reports: readonly ProviderReport[]): CoverageMatrix {
  const kinds: KindCoverage[] = [];
  const unclaimed: StructuralKind[] = [];

  for (const kind of STRUCTURAL_KINDS) {
    const cells: CoverageCell[] = [];
    let totalRecords = 0;

    for (const report of reports) {
      const declarations = report.capabilities.declarations.filter((d) => d.kind === kind);
      // Records carry no language, so this is the kind's total for the
      // provider rather than a per-language figure. Stated plainly because a
      // reader could otherwise mistake it for one.
      const recordCount = report.contribution.records[kind].length;
      const kindGaps = report.contribution.gaps.filter((gap) => gap.kind === kind);
      totalRecords += recordCount;

      const covered = new Set<string>();

      for (const declaration of declarations) {
        const level: CoverageLevel =
          declaration.support === "none"
            ? "absent"
            : declaration.support === "partial"
              ? "partial"
              : "full";
        const gap = gapFor(kindGaps, kind, declaration.language);
        if (gap) covered.add(gap.language);

        cells.push({
          kind,
          providerId: report.providerId,
          language: declaration.language,
          level,
          recordCount,
          limits: declaration.limits,
          gapReason: gap?.reason ?? null,
        });
      }

      // Gaps for languages no declaration mentioned still belong in the matrix.
      // Silence is not the same as a declared "none": a kind nobody considered
      // should not read as a deliberate refusal.
      for (const gap of kindGaps) {
        if (covered.has(gap.language)) continue;
        covered.add(gap.language);
        cells.push({
          kind,
          providerId: report.providerId,
          language: gap.language,
          level: "absent",
          recordCount,
          limits: [],
          gapReason: gap.reason,
        });
      }
    }

    const covered = cells.some((cell) => cell.level !== "absent" && cell.recordCount > 0);
    if (cells.length === 0) unclaimed.push(kind);

    kinds.push({
      kind,
      covered,
      totalRecords,
      cells,
      emptyIsSuspicious: isUniversalKind(kind),
    });
  }

  return { kinds, unclaimedKinds: unclaimed };
}

/**
 * Renders the matrix as Markdown.
 *
 * Written from the same data the assertions use, so the document and the
 * behaviour cannot disagree — a coverage matrix maintained by hand is a
 * coverage matrix that is wrong within a month.
 */
export function renderCoverageMatrix(matrix: CoverageMatrix): string {
  const lines: string[] = [
    "# Coverage matrix",
    "",
    "Generated from declared capabilities and observed record counts. Do not edit by hand.",
    "",
    "| Kind | Provider | Language | Support | Records | Notes |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const kind of matrix.kinds) {
    if (kind.cells.length === 0) {
      lines.push(`| \`${kind.kind}\` | — | — | unclaimed | 0 | no provider addresses this kind |`);
      continue;
    }
    for (const cell of kind.cells) {
      const notes = [cell.gapReason, ...cell.limits].filter(Boolean).join("; ") || "—";
      lines.push(
        `| \`${cell.kind}\` | ${cell.providerId} | ${cell.language} | ${cell.level} | ${cell.recordCount} | ${notes} |`,
      );
    }
  }

  const suspicious = matrix.kinds.filter((kind) => kind.emptyIsSuspicious && kind.totalRecords === 0);
  if (suspicious.length > 0) {
    lines.push(
      "",
      "## Empty results worth questioning",
      "",
      "These kinds fall out of code structure in any language, so an empty result suggests a gap rather than a property of the project:",
      "",
      ...suspicious.map((kind) => `- \`${kind.kind}\``),
    );
  }

  if (matrix.unclaimedKinds.length > 0) {
    lines.push(
      "",
      "## Unclaimed kinds",
      "",
      "Defined by the model, addressed by no provider. Each is a place a provider could be added:",
      "",
      ...matrix.unclaimedKinds.map((kind) => `- \`${kind}\``),
    );
  }

  return `${lines.join("\n")}\n`;
}
