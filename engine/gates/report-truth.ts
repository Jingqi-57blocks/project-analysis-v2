/**
 * The WCP-V2 report truth gate (PI-68).
 *
 * Grades the facet=M3 truth items against the compiled report — for each item,
 * whether the fact its category implies is routed into the section of the report
 * its `requiredScope × requiredAudience` names, and whether that section is present
 * with its required blocks accounted (a required authored block that failed
 * validation is not accounted). Every item lands in exactly one mutually-exclusive
 * bucket and the total is conserved. The golden-slice hard gate passes only when
 * every must-print item is printed in its required scope × audience, no critical
 * item is unprinted, no claim falls outside its document's scope, and a shared
 * claim required in both audiences is not present in one and absent in the other.
 *
 * It grades the plan and the validated block set, not source: the report is the
 * pipeline's (PI-14/15/16/17/73) to compile and execute; this checks that the
 * found facts reach the right document section — the M3 contract before the M4
 * fresh-run content match. Routing prefers the truth item's own named section
 * (scope + audience + section); a documented category→section lane is the fallback
 * for an item that names none, the report analogue of the M2 behaviour gate's
 * category→kind lane.
 *
 * Two checks are content-level and land with the rendered report, not the plan, so
 * they are deferred (not silently skipped): the fact-outside-slice check is
 * `validateFactAgainstSlice` at the M4 fresh run, and citation truth (an uncited or
 * wrong-cited claim) is enforced by each authored block's `citationRule: "required"`
 * validator at execution and by the M6 citation-truth metric. This gate grades
 * routing and structural block accounting; it does not read rendered citations.
 *
 * The gate assumes the plan carries every audience an item requires (the dual
 * product+developer document plan it is built for); single-document accounting is
 * PI-73's combination gate, not this one.
 */

import type { ReportAudience, ReportScope, TruthItem } from "../contracts/truth/schema.js";
import { type Audience, type Scope, moduleScope, targetKey } from "../contracts/report/target.js";
import type { ExecutableReportPlan } from "../report/plan.js";
import type { DocumentPlan } from "../contracts/report/pipeline.js";

export type ReportTruthStatus =
  | "printed"
  | "counted"
  | "omitted"
  | "not-applicable"
  | "unknown"
  | "unsupported"
  | "missing";

/**
 * Category → the report section(s) that carry it, per audience, at module scope —
 * the fallback for a truth item that does not name its own sections. The critical
 * must-print notifications name a single section, so the hard gate is precise
 * regardless of this lane.
 */
const REPORT_SECTION_LANE: Readonly<Record<string, Partial<Record<ReportAudience, readonly string[]>>>> = {
  notification: {
    product: ["module-notifications-data"],
    developer: ["module-data-control-errors"],
  },
  "pm-vs-dev": {
    product: ["module-objects-rules-states", "module-flows-branches", "module-notifications-data"],
    developer: ["module-branches-rules-states", "module-data-control-errors"],
  },
  "dev-only": {
    developer: ["module-impl-issues"],
  },
  "coverage-honesty": {
    product: ["coverage", "known-issues"],
    developer: ["coverage", "known-issues"],
  },
};

/** How one required (scope, audience) placement of an item resolved. */
export type PlacementDisposition = "carried" | "unvalidated" | "omitted" | "unknown" | "absent";

export interface ReportPlacement {
  readonly scope: ReportScope;
  readonly audience: ReportAudience;
  /** The section that carried the item, or null when none of its candidates was present. */
  readonly sectionId: string | null;
  readonly present: boolean;
  /** The section is present and its required authored blocks all validated. */
  readonly accounted: boolean;
  readonly disposition: PlacementDisposition;
  readonly detail: string;
}

export interface ReportItemResult {
  readonly truthId: string;
  readonly category: string;
  readonly criticality: string;
  readonly mustPrint: boolean;
  readonly mustFind: boolean;
  readonly requiredScope: readonly ReportScope[];
  readonly requiredAudience: readonly ReportAudience[];
  readonly status: ReportTruthStatus;
  readonly placements: readonly ReportPlacement[];
  readonly detail: string;
}

export interface ReportGateReport {
  readonly documentIds: readonly string[];
  readonly total: number;
  readonly results: readonly ReportItemResult[];
  readonly counts: Readonly<Record<ReportTruthStatus, number>>;
  readonly mustPrintTotal: number;
  readonly mustPrintPrinted: number;
  /** Claims whose required section falls outside the document's scope. */
  readonly sliceOutClaims: number;
  /** Shared claims present in one required audience but absent in another. */
  readonly crossReportConflicts: number;
  readonly criticalIssues: number;
  readonly passed: boolean;
}

const ALL_STATUSES: readonly ReportTruthStatus[] = [
  "printed",
  "counted",
  "omitted",
  "not-applicable",
  "unknown",
  "unsupported",
  "missing",
];

function scopeValue(scope: ReportScope, moduleId: string): Scope {
  return scope === "project" ? { kind: "project" } : moduleScope(moduleId);
}

interface Expectation {
  readonly scope: ReportScope;
  readonly audience: ReportAudience;
  /** The acceptable sections for this placement — one when named, several from the lane. */
  readonly candidates: readonly string[];
}

/**
 * Where an item must appear. An item that names its sections (scope + audience +
 * section) is routed precisely; one that names none falls back to the category
 * lane over its required scope × audience.
 */
function expectationsOf(item: TruthItem): readonly Expectation[] {
  if (item.reportSections !== undefined && item.reportSections.length > 0) {
    return item.reportSections.map((rs) => ({ scope: rs.scope, audience: rs.audience, candidates: [rs.sectionId] }));
  }
  const lane = REPORT_SECTION_LANE[item.category];
  if (lane === undefined) return [];
  const out: Expectation[] = [];
  for (const scope of item.requiredScope) {
    for (const audience of item.requiredAudience) {
      const candidates = lane[audience];
      if (candidates !== undefined && candidates.length > 0) out.push({ scope, audience, candidates });
    }
  }
  return out;
}

/** A section is accounted when present and every authored-required block in it validated. */
function sectionAccounted(doc: DocumentPlan, sectionId: string, validatedTaskIds: ReadonlySet<string>): boolean {
  const section = doc.sections.find((s) => s.sectionId === sectionId);
  if (section === undefined) return false;
  return section.blocks.every((b) => b.task === undefined || validatedTaskIds.has(b.task.taskId));
}

/**
 * Grade the M3 truth items against a compiled, executed report. `moduleId` is the
 * canonical module the module-scope items belong to; `validatedTaskIds` are the
 * authored tasks whose blocks validated (from execution). Deterministic.
 */
export function gradeReportTruth(
  items: readonly TruthItem[],
  executable: ExecutableReportPlan,
  validatedTaskIds: ReadonlySet<string>,
  moduleId: string,
): ReportGateReport {
  const docByKey = new Map(executable.plan.documents.map((d) => [d.documentId, d] as const));
  const applicabilityByDocSection = new Map(
    executable.applicability.map((a) => [`${a.documentId} ${a.decision.sectionId}`, a.decision] as const),
  );

  const results: ReportItemResult[] = items.map((item) => {
    const base = {
      truthId: item.id,
      category: item.category,
      criticality: item.criticality,
      mustPrint: item.mustPrint,
      mustFind: item.mustFind,
      requiredScope: item.requiredScope,
      requiredAudience: item.requiredAudience,
    };

    // Prefer the item's own named sections (scope + audience + section); fall back
    // to the category→section lane only when the truth item names none.
    const expectations = expectationsOf(item);
    if (expectations.length === 0) {
      // An item that routes nowhere is a hard fail when it must print or is critical
      // — it can never be printed, so it cannot drop out of the denominator as
      // "unsupported". Only a non-critical, non-must-print item is honestly
      // unsupported (out of the hard gate's scope).
      const status: ReportTruthStatus = item.mustPrint || item.criticality === "critical" ? "missing" : "unsupported";
      return { ...base, status, placements: [], detail: `category ${item.category} routes to no named section or report lane` };
    }

    const placements: ReportPlacement[] = [];
    for (const { scope, audience, candidates } of expectations) {
      const documentId = targetKey({ scope: scopeValue(scope, moduleId), audience: audience as Audience });
      const doc = docByKey.get(documentId);
      if (doc === undefined) {
        placements.push({ scope, audience, sectionId: null, present: false, accounted: false, disposition: "absent", detail: `no ${documentId} document was generated` });
        continue;
      }
      const present = candidates.find((sectionId) => doc.sections.some((s) => s.sectionId === sectionId));
      if (present !== undefined) {
        const accounted = sectionAccounted(doc, present, validatedTaskIds);
        placements.push({
          scope,
          audience,
          sectionId: present,
          present: true,
          accounted,
          disposition: accounted ? "carried" : "unvalidated",
          detail: accounted ? `carried by ${present}` : `${present} present but a required authored block did not validate`,
        });
        continue;
      }
      // No candidate present — distinguish an evidenced not-applicable / unknown
      // omission from a real miss, using the applicability decision.
      const decision = candidates
        .map((sectionId) => applicabilityByDocSection.get(`${documentId} ${sectionId}`))
        .find((d) => d !== undefined);
      const applicability = decision?.applicability;
      const disposition: PlacementDisposition =
        applicability === "not-applicable" ? "omitted" : applicability === "unknown" ? "unknown" : "absent";
      placements.push({
        scope,
        audience,
        sectionId: null,
        present: false,
        accounted: false,
        disposition,
        detail:
          disposition === "omitted"
            ? `omitted: ${decision?.reason ?? "not applicable"}`
            : disposition === "unknown"
              ? `unknown: ${decision?.reason ?? "not established"}`
              : `no candidate section present in ${documentId}`,
      });
    }

    if (placements.length === 0) {
      // Defensive: expectations always yield a placement, so this is unreachable for
      // a compiled dual-document plan. If it ever is reached, a must-print/critical
      // item fails closed rather than dropping out of the denominator.
      const status: ReportTruthStatus = item.mustPrint || item.criticality === "critical" ? "missing" : "unsupported";
      return { ...base, status, placements, detail: "the item routes to no requested document/audience" };
    }

    // Aggregate the placements into one status off the structured dispositions —
    // never a string match on the detail.
    const anyMissing = placements.some((p) => p.disposition === "absent" || p.disposition === "unvalidated");
    const anyUnknown = placements.some((p) => p.disposition === "unknown");
    const anyOmitted = placements.some((p) => p.disposition === "omitted");
    const allCarried = placements.every((p) => p.disposition === "carried");

    let status: ReportTruthStatus;
    if (item.mustPrint) {
      // A must-print fact is printed only when carried everywhere it is required. An
      // honest not-applicable / unknown for a fact that should be found does not
      // satisfy it — accounting balance never substitutes for printing.
      status = allCarried
        ? "printed"
        : anyMissing
          ? "missing"
          : anyUnknown
            ? "unknown"
            : item.expectedStatus !== "found"
              ? "omitted"
              : "missing";
    } else if (allCarried) {
      status = "counted";
    } else if (anyMissing) {
      status = "missing";
    } else if (anyUnknown) {
      status = item.expectedStatus === "unresolved" ? "counted" : "unknown";
    } else if (anyOmitted && item.expectedStatus !== "found") {
      status = "omitted";
    } else {
      status = "counted";
    }

    const detail = placements.map((p) => `${p.scope}/${p.audience}: ${p.detail}`).join(" | ");
    return { ...base, status, placements, detail };
  });

  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<ReportTruthStatus, number>;
  for (const r of results) counts[r.status] += 1;

  // A slice-out claim is one routed into a document whose actual scope differs from
  // the scope it was placed under — the compiler keys each document by (scope,
  // audience), so a healthy plan has none; this catches a mis-scoped document
  // rather than trusting it. The content-level fact-outside-slice check is
  // validateFactAgainstSlice at the M4 fresh run.
  const sliceOutClaims = results.reduce((n, r) => {
    return (
      n +
      r.placements.filter((p) => {
        if (!p.present) return false;
        const doc = docByKey.get(targetKey({ scope: scopeValue(p.scope, moduleId), audience: p.audience as Audience }));
        const docScope: ReportScope = doc !== undefined && doc.scope.kind === "module" ? "module" : "project";
        return doc !== undefined && docScope !== p.scope;
      }).length
    );
  }, 0);

  // Every must-print item counts toward the denominator, and every critical item
  // that is not printed is an issue — "unsupported" is not a way out, since an
  // unroutable must-print/critical item is already classified "missing" above.
  const mustPrint = results.filter((r) => r.mustPrint);
  const mustPrintPrinted = mustPrint.filter((r) => r.status === "printed").length;
  const criticalIssues = results.filter((r) => r.criticality === "critical" && r.status !== "printed").length;

  // A shared claim required in both audiences that is present for one and absent
  // for the other — a cross-report inconsistency.
  const crossReportConflicts = results.filter((r) => {
    if (r.requiredAudience.length < 2) return false;
    const byAudience = new Map<ReportAudience, boolean>();
    for (const p of r.placements) byAudience.set(p.audience, (byAudience.get(p.audience) ?? false) || p.present);
    const values = [...byAudience.values()];
    return values.length >= 2 && values.some((v) => v) && values.some((v) => !v);
  }).length;

  return {
    documentIds: [...docByKey.keys()].sort(),
    total: results.length,
    results,
    counts,
    mustPrintTotal: mustPrint.length,
    mustPrintPrinted,
    sliceOutClaims,
    crossReportConflicts,
    criticalIssues,
    passed:
      mustPrintPrinted === mustPrint.length &&
      criticalIssues === 0 &&
      sliceOutClaims === 0 &&
      crossReportConflicts === 0,
  };
}
