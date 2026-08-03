import { describe, expect, it } from "vitest";

import {
  goldenSliceItems,
  itemsForFacet,
  loadLeaveTruthLedger,
  mustPrintItems,
} from "../../../engine/contracts/truth/leave.js";
import { TRUTH_FACETS, validateLedger } from "../../../engine/contracts/truth/schema.js";

const ledger = loadLeaveTruthLedger();

describe("WCP-V2 leave truth ledger", () => {
  it("loads and validates structurally", () => {
    const result = validateLedger(ledger);
    expect(result.ok, result.ok ? "" : result.reasons.join("; ")).toBe(true);
  });

  it("freezes the leave roots at 40-char SHAs", () => {
    const names = ledger.manifest.roots.map((r) => r.name);
    expect(names).toContain("wcp-service-v2");
    for (const root of ledger.manifest.roots) {
      expect(root.sha, root.name).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("is deterministic — a reload yields the same inventory", () => {
    const again = loadLeaveTruthLedger();
    expect(again.items.map((i) => i.id)).toEqual(ledger.items.map((i) => i.id));
  });

  it("lets each gate filter its own facet, and every item belongs to at least one", () => {
    const covered = new Set<string>();
    for (const facet of TRUTH_FACETS) for (const item of itemsForFacet(ledger, facet)) covered.add(item.id);
    expect(covered.size).toBe(ledger.items.length);
    expect(itemsForFacet(ledger, "M1").length).toBeGreaterThan(0);
    expect(itemsForFacet(ledger, "M2").length).toBeGreaterThan(0);
  });

  it("has a non-empty golden slice, every member critical and must-find", () => {
    const golden = goldenSliceItems(ledger);
    expect(golden.length).toBeGreaterThan(0);
    for (const item of golden) {
      expect(item.criticality, item.id).toBe("critical");
      expect(item.mustFind, item.id).toBe(true);
    }
  });

  it("every must-print item names a required scope and audience", () => {
    for (const item of ledger.items.filter((i) => i.mustPrint)) {
      expect(item.requiredScope.length, item.id).toBeGreaterThan(0);
      expect(item.requiredAudience.length, item.id).toBeGreaterThan(0);
    }
  });

  it("carries module-scoped must-print items for the leave module request", () => {
    const modProduct = mustPrintItems(ledger, "module", "product");
    const modDeveloper = mustPrintItems(ledger, "module", "developer");
    expect(modProduct.length + modDeveloper.length).toBeGreaterThan(0);
  });
});
