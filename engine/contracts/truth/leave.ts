/**
 * Loader for the WCP-V2 leave truth ledger.
 *
 * The data is versioned JSON under truth-set/leave/, beside the human-readable
 * reference. Loading is deterministic — the same frozen file yields the same
 * inventory — and the gates filter it by facet or by golden-slice membership.
 */

import { readFileSync } from "node:fs";

import type { ReportAudience, ReportScope, TruthFacet, TruthItem, TruthLedger } from "./schema.js";

const LEDGER_URL = new URL("../../../truth-set/leave/ledger.json", import.meta.url);

export function loadLeaveTruthLedger(): TruthLedger {
  return JSON.parse(readFileSync(LEDGER_URL, "utf8")) as TruthLedger;
}

export function itemsForFacet(ledger: TruthLedger, facet: TruthFacet): readonly TruthItem[] {
  return ledger.items.filter((item) => item.facets.includes(facet));
}

/** The golden-slice items: critical must-find. PI-58 requires 100% of these found. */
export function goldenSliceItems(ledger: TruthLedger): readonly TruthItem[] {
  return ledger.items.filter((item) => item.criticality === "critical" && item.mustFind);
}

/** Items that must be printed in a given scope × audience report. */
export function mustPrintItems(
  ledger: TruthLedger,
  scope: ReportScope,
  audience: ReportAudience,
): readonly TruthItem[] {
  return ledger.items.filter(
    (item) =>
      item.mustPrint && item.requiredScope.includes(scope) && item.requiredAudience.includes(audience),
  );
}
