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
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
