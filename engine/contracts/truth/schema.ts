/**
 * The machine-readable shape of a truth item and ledger.
 *
 * A truth set is the frozen, evidence-anchored expectation a fresh analysis is
 * graded against. Items are tagged by gate facet (M1..M4) so each milestone
 * filters its own, and by the golden-slice classification (criticality,
 * mustFind, mustPrint, required scope/audience) that PI-58 turns into hard
 * thresholds. The ledger is versioned and immutable: an update is a new version,
 * never an in-place rewrite of a frozen baseline.
 *
 * This is the schema and its validator. The data lives in truth-set/, versioned
 * beside the human-readable reference; the loaders below read and check it.
 */


export type TruthFacet = "M1" | "M2" | "M3" | "M4";
export const TRUTH_FACETS: readonly TruthFacet[] = ["M1", "M2", "M3", "M4"];

/** How well the code is expected to support the item, as the analyzer should report it. */
export type ExpectedResolution = "observed" | "inferred" | "unresolved" | "absent";
export const EXPECTED_RESOLUTIONS: readonly ExpectedResolution[] = [
  "observed",
  "inferred",
  "unresolved",
  "absent",
];

/** The coverage outcome a fresh run should reach for the item. */
export type ExpectedStatus = "found" | "unresolved" | "absent" | "not-applicable";
export const EXPECTED_STATUSES: readonly ExpectedStatus[] = [
  "found",
  "unresolved",
  "absent",
  "not-applicable",
];

export type TruthCriticality = "critical" | "normal";
export type ReportScope = "project" | "module";
export type ReportAudience = "product" | "developer";

export interface TruthEvidence {
  /** The root the citation is in: wcp-service-v2 | wcp-ui | wcp-service. */
  readonly root: string;
  /** Path relative to the root. */
  readonly path: string;
  /** A line or lines: "30" | "66,89" | "460-465". Absent for whole-file evidence. */
  readonly lines?: string;
  readonly note?: string;
}

/**
 * The report section that must carry an item, named with its scope and audience
 * (PI-68: an M3 expectation must name a section, not just "appears in both
 * reports"). A mustPrint item must name a section for every scope × audience it is
 * required in, so the gate can check routing precisely rather than by category.
 */
export interface ReportSectionExpectation {
  readonly scope: ReportScope;
  readonly audience: ReportAudience;
  readonly sectionId: string;
}

export interface TruthItem {
  readonly id: string;
  readonly facets: readonly TruthFacet[];
  /** Open label — entry-point, transition, permission, notification, … */
  readonly category: string;
  readonly claim: string;
  readonly evidence: readonly TruthEvidence[];
  readonly expectedResolution: ExpectedResolution;
  readonly expectedStatus: ExpectedStatus;
  readonly criticality: TruthCriticality;
  readonly mustFind: boolean;
  readonly mustPrint: boolean;
  readonly requiredScope: readonly ReportScope[];
  readonly requiredAudience: readonly ReportAudience[];
  /**
   * The section that carries this item, per scope × audience. Required for a
   * mustPrint item; optional otherwise. When absent, the M3 gate falls back to its
   * category→section lane.
   */
  readonly reportSections?: readonly ReportSectionExpectation[];
  /** The condition under which an unresolved/absent result is acceptable, if any. */
  readonly allowedUnresolved?: string;
}

export interface TruthRootRevision {
  readonly name: string;
  readonly language: string;
  readonly sha: string;
  readonly dirty: boolean;
  readonly dirtyNote?: string;
}

export interface TruthSetManifest {
  readonly targetId: string;
  readonly module: string;
  /** Semantic version of the ledger. An update bumps this; the baseline is never rewritten. */
  readonly version: string;
  readonly roots: readonly TruthRootRevision[];
  /** Honest freeze status, e.g. "draft-source-verified, pending human sign-off". */
  readonly status: string;
}

export interface TruthLedger {
  readonly manifest: TruthSetManifest;
  readonly items: readonly TruthItem[];
}

export type LedgerValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Structural validation of a ledger. Enforces the invariants the gates rely on:
 * unique ids, cited evidence, valid facets/enums, and the golden-slice coupling
 * (critical ⇒ mustFind; mustPrint ⇒ a required scope and audience). Does not
 * check the citations against source — that is the source-verification step.
 */
export function validateLedger(ledger: TruthLedger): LedgerValidation {
  const reasons: string[] = [];
  const ids = new Set<string>();
  const roots = new Set(ledger.manifest.roots.map((r) => r.name));

  if (ledger.manifest.roots.length === 0) reasons.push("manifest has no roots");
  for (const root of ledger.manifest.roots) {
    if (!/^[0-9a-f]{40}$/.test(root.sha)) reasons.push(`root ${root.name} has a non-SHA revision`);
  }

  for (const item of ledger.items) {
    if (ids.has(item.id)) reasons.push(`duplicate truth id: ${item.id}`);
    ids.add(item.id);

    if (item.facets.length === 0) reasons.push(`${item.id}: no facet`);
    for (const facet of item.facets) {
      if (!TRUTH_FACETS.includes(facet)) reasons.push(`${item.id}: unknown facet ${facet}`);
    }
    if (!EXPECTED_RESOLUTIONS.includes(item.expectedResolution)) {
      reasons.push(`${item.id}: unknown expectedResolution ${item.expectedResolution}`);
    }
    if (!EXPECTED_STATUSES.includes(item.expectedStatus)) {
      reasons.push(`${item.id}: unknown expectedStatus ${item.expectedStatus}`);
    }
    if (item.evidence.length === 0) reasons.push(`${item.id}: no evidence`);
    for (const evidence of item.evidence) {
      if (evidence.root.length === 0 || evidence.path.length === 0) {
        reasons.push(`${item.id}: evidence missing root or path`);
      }
      if (!roots.has(evidence.root)) reasons.push(`${item.id}: evidence root ${evidence.root} not in manifest`);
    }
    if (item.criticality === "critical" && !item.mustFind) {
      reasons.push(`${item.id}: critical item must be mustFind`);
    }
    if (item.mustPrint && (item.requiredScope.length === 0 || item.requiredAudience.length === 0)) {
      reasons.push(`${item.id}: mustPrint item needs a required scope and audience`);
    }

    // A named section must sit inside the item's required scope and audience; a
    // mustPrint item must name one for every scope × audience it is required in, so
    // the M3 gate routes it precisely instead of by category (PI-68).
    for (const rs of item.reportSections ?? []) {
      if (!item.requiredScope.includes(rs.scope)) reasons.push(`${item.id}: reportSection scope ${rs.scope} not in requiredScope`);
      if (!item.requiredAudience.includes(rs.audience)) reasons.push(`${item.id}: reportSection audience ${rs.audience} not in requiredAudience`);
      // The section name is kept as a routing hint the truth ledger records; it is
      // no longer checked against a catalog, because a report's chapters are now
      // the spec's prose rather than a compiled section graph.
      if (rs.sectionId.length === 0) reasons.push(`${item.id}: reportSection names no section`);
    }
    // Section routing is the M3 report facet's concern: an M3 must-print item must
    // name a section for every scope × audience it prints in. A must-print item at
    // the M1/M2 facets asserts it is found in structure/behaviour; its report
    // routing is pinned by the M3 items, not here. And any item that names *some*
    // sections must name one for every required scope × audience — a partial routing
    // would leave one audience unchecked and let a cross-report inconsistency slip.
    const namesSome = (item.reportSections ?? []).length > 0;
    if (namesSome || (item.mustPrint && item.facets.includes("M3"))) {
      const named = new Set((item.reportSections ?? []).map((rs) => `${rs.scope}|${rs.audience}`));
      for (const scope of item.requiredScope) {
        for (const audience of item.requiredAudience) {
          if (!named.has(`${scope}|${audience}`)) {
            reasons.push(`${item.id}: must name a report section for every required scope × audience (${scope}/${audience})`);
          }
        }
      }
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
