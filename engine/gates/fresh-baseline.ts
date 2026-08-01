/**
 * The WCP-V2 leave fresh-baseline aggregator (PI-19).
 *
 * A fresh run grades the truth ledger through three layered gates — structure
 * (PI-65), behaviour (PI-67) and report (PI-68) — over one analysis snapshot. This
 * folds those three receipts into one baseline: every truth item gets a single
 * disposition and the responsibility layer that owns it, the buckets conserve the
 * total, and the gaps are collected into a machine-readable ledger for the generic
 * fixes (PI-20) to work from.
 *
 * Attribution is layered, so a gap lands on the earliest layer that failed: a fact
 * absent from the code graph is a CodeGraph gap (the deriver and report never had a
 * chance); one present structurally but never derived is a deriver gap; one derived
 * but not printed is a report gap. This measures and attributes — it fixes nothing,
 * and treats no prior run, product expectation or chat conclusion as evidence.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import type { TruthFacet, TruthItem } from "../contracts/truth/schema.js";
import type { StructuralGateReport, TruthStatus } from "./structural-truth.js";
import type { BehaviorGateReport } from "./behavior-truth.js";
import type { ReportGateReport, ReportTruthStatus } from "./report-truth.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export type Disposition =
  | "observed"
  | "printed"
  | "counted"
  | "unresolved"
  | "missing"
  | "wrong"
  | "not-applicable"
  | "provider-failure"
  | "unsupported";

export const DISPOSITIONS: readonly Disposition[] = [
  "observed",
  "printed",
  "counted",
  "unresolved",
  "missing",
  "wrong",
  "not-applicable",
  "provider-failure",
  "unsupported",
];

/** The pipeline layer a disposition is attributed to. */
export type ResponsibilityLayer = "codegraph" | "deriver" | "report" | "provider" | "none";

/** A disposition that is a gap the fix pass must account — not a clean pass. */
const GAP_DISPOSITIONS: ReadonlySet<Disposition> = new Set<Disposition>([
  "missing",
  "wrong",
  "unresolved",
  "provider-failure",
  "unsupported",
]);

const LAYER_BY_FACET: Readonly<Record<Exclude<TruthFacet, "M4">, ResponsibilityLayer>> = {
  M1: "codegraph",
  M2: "deriver",
  M3: "report",
};

const FACET_ORDER: readonly Exclude<TruthFacet, "M4">[] = ["M1", "M2", "M3"];

function fromStructural(status: TruthStatus): Disposition {
  switch (status) {
    case "found":
      return "observed";
    case "not-found":
      return "missing";
    case "failed":
      return "provider-failure";
    case "truncated":
    case "unresolved":
      return "unresolved";
    case "unsupported":
      return "unsupported";
  }
}

function fromReport(status: ReportTruthStatus): Disposition {
  switch (status) {
    case "printed":
      return "printed";
    case "counted":
      return "counted";
    case "omitted":
    case "not-applicable":
      return "not-applicable";
    case "unknown":
      return "unresolved";
    case "missing":
      return "missing";
    case "unsupported":
      return "unsupported";
  }
}

export interface ItemDisposition {
  readonly truthId: string;
  readonly facets: readonly TruthFacet[];
  readonly criticality: string;
  readonly disposition: Disposition;
  readonly layer: ResponsibilityLayer;
  readonly detail: string;
}

export interface GapEntry {
  readonly truthId: string;
  readonly disposition: Disposition;
  readonly layer: ResponsibilityLayer;
  readonly criticality: string;
  readonly detail: string;
}

export interface RunManifest {
  readonly snapshotIdentity: string;
  readonly truthVersion: string;
  readonly pipelineVersion: string;
  readonly structuralRoot: string;
  readonly reportDocuments: readonly string[];
  /** True when the three gates graded the same source snapshot as this run. */
  readonly identitiesMatch: boolean;
}

export interface FreshBaseline {
  readonly manifest: RunManifest;
  readonly total: number;
  readonly dispositions: readonly ItemDisposition[];
  readonly counts: Readonly<Record<Disposition, number>>;
  /** The gaps, most-critical first then by id — the input to PI-20. */
  readonly gapLedger: readonly GapEntry[];
  readonly projectLevelDocuments: number;
  readonly projectLevelTasks: number;
  /** The measurement is valid: buckets conserve, the module-only request has zero project footprint, and the gate identities match. This is not "the analysis found everything". */
  readonly wellFormed: boolean;
  /** The golden slice actually passed: all three layered gates passed on this fresh run. False while any layer has an unclosed gap. */
  readonly goldenSlicePassed: boolean;
  readonly digest: string;
}

export interface BaselineInputs {
  readonly truthItems: readonly TruthItem[];
  readonly structural: StructuralGateReport;
  readonly behavior: BehaviorGateReport;
  readonly report: ReportGateReport;
  readonly manifest: RunManifest;
  readonly projectLevelDocuments: number;
  readonly projectLevelTasks: number;
}

/** Grade one item through the layers its facets touch, stopping at the earliest gap. */
function disposeItem(
  item: TruthItem,
  structural: StructuralGateReport,
  behavior: BehaviorGateReport,
  report: ReportGateReport,
): { disposition: Disposition; layer: ResponsibilityLayer; detail: string } {
  let deepest: { disposition: Disposition; layer: ResponsibilityLayer; detail: string } | null = null;

  for (const facet of FACET_ORDER) {
    if (!item.facets.includes(facet)) continue;
    const layer = LAYER_BY_FACET[facet];

    let disposition: Disposition;
    let detail: string;
    if (facet === "M3") {
      const r = report.results.find((x) => x.truthId === item.id);
      if (r === undefined) continue;
      disposition = fromReport(r.status);
      detail = r.detail;
    } else {
      const gate = facet === "M1" ? structural : behavior;
      const r = gate.results.find((x) => x.truthId === item.id);
      if (r === undefined) continue;
      disposition = fromStructural(r.status);
      detail = r.detail;
    }

    // A gap at this layer is where the item's flow broke — attribute it here and stop.
    if (GAP_DISPOSITIONS.has(disposition) || disposition === "not-applicable") {
      return { disposition, layer, detail };
    }
    deepest = { disposition, layer, detail };
  }

  return deepest ?? { disposition: "not-applicable", layer: "none", detail: "no gate in scope graded this item" };
}

const CRITICALITY_RANK: Readonly<Record<string, number>> = { critical: 0, normal: 1 };

export function aggregateFreshBaseline(input: BaselineInputs): FreshBaseline {
  const dispositions: ItemDisposition[] = input.truthItems
    .map((item) => {
      const d = disposeItem(item, input.structural, input.behavior, input.report);
      return { truthId: item.id, facets: item.facets, criticality: item.criticality, disposition: d.disposition, layer: d.layer, detail: d.detail };
    })
    .sort((a, b) => (a.truthId < b.truthId ? -1 : a.truthId > b.truthId ? 1 : 0));

  const counts = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<Disposition, number>;
  for (const d of dispositions) counts[d.disposition] += 1;

  const gapLedger: GapEntry[] = dispositions
    .filter((d) => GAP_DISPOSITIONS.has(d.disposition))
    .map((d) => ({ truthId: d.truthId, disposition: d.disposition, layer: d.layer, criticality: d.criticality, detail: d.detail }))
    .sort((a, b) => {
      const ra = CRITICALITY_RANK[a.criticality] ?? 9;
      const rb = CRITICALITY_RANK[b.criticality] ?? 9;
      return ra !== rb ? ra - rb : a.truthId < b.truthId ? -1 : a.truthId > b.truthId ? 1 : 0;
    });

  const bucketsConserve = dispositions.length === input.truthItems.length && Object.values(counts).reduce((a, b) => a + b, 0) === dispositions.length;
  const wellFormed =
    bucketsConserve &&
    input.projectLevelDocuments === 0 &&
    input.projectLevelTasks === 0 &&
    input.manifest.identitiesMatch;
  // The golden slice passes only when every layered gate passed on this fresh run —
  // a gap in any layer (a missing structural fact, an underived behaviour fact, an
  // unprinted report claim) means it did not, however well-formed the measurement.
  const goldenSlicePassed = input.structural.passed && input.behavior.passed && input.report.passed;

  return {
    manifest: input.manifest,
    total: dispositions.length,
    dispositions,
    counts,
    gapLedger,
    projectLevelDocuments: input.projectLevelDocuments,
    projectLevelTasks: input.projectLevelTasks,
    wellFormed,
    goldenSlicePassed,
    digest: digest({ manifest: input.manifest, dispositions, projectLevelDocuments: input.projectLevelDocuments, projectLevelTasks: input.projectLevelTasks }),
  };
}
