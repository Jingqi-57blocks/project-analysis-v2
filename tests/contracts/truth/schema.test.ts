import { describe, expect, it } from "vitest";

import { type TruthItem, type TruthLedger, validateLedger } from "../../../engine/contracts/truth/schema.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function ledger(item: Partial<TruthItem>): TruthLedger {
  const base: TruthItem = {
    id: "T-1",
    facets: ["M3"],
    category: "notification",
    claim: "x",
    evidence: [{ root: "wcp-service-v2", path: "a.go" }],
    expectedResolution: "observed",
    expectedStatus: "found",
    criticality: "normal",
    mustFind: true,
    mustPrint: false,
    requiredScope: ["module"],
    requiredAudience: ["product"],
  };
  return {
    manifest: {
      targetId: "wcp-v2",
      module: "leave",
      version: "0.1.0",
      roots: [{ name: "wcp-service-v2", language: "go", sha: SHA, dirty: false }],
      status: "draft",
    },
    items: [{ ...base, ...item }],
  };
}

describe("validateLedger — M3 report-section routing", () => {
  it("rejects an M3 must-print item that names no section", () => {
    const result = validateLedger(ledger({ mustPrint: true, criticality: "critical" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.some((r) => r.includes("must name a report section for every required scope × audience (module/product)"))).toBe(true);
  });

  it("accepts an M3 must-print item that names a section for every required scope × audience", () => {
    const result = validateLedger(
      ledger({
        mustPrint: true,
        criticality: "critical",
        requiredAudience: ["product", "developer"],
        reportSections: [
          { scope: "module", audience: "product", sectionId: "module-notifications-data" },
          { scope: "module", audience: "developer", sectionId: "module-data-control-errors" },
        ],
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a named section whose scope or audience is not among the item's required set", () => {
    const scopeMismatch = validateLedger(
      ledger({ reportSections: [{ scope: "project", audience: "product", sectionId: "s" }] }),
    );
    expect(scopeMismatch.ok).toBe(false);
    if (!scopeMismatch.ok) expect(scopeMismatch.reasons.some((r) => r.includes("scope project not in requiredScope"))).toBe(true);

    const audienceMismatch = validateLedger(
      ledger({ reportSections: [{ scope: "module", audience: "developer", sectionId: "s" }] }),
    );
    expect(audienceMismatch.ok).toBe(false);
    if (!audienceMismatch.ok) expect(audienceMismatch.reasons.some((r) => r.includes("audience developer not in requiredAudience"))).toBe(true);
  });



  it("accepts a section name from any scope × audience the item requires", () => {
    // The section name is a routing hint the ledger records. It is no longer
    // checked against a catalog: a report's chapters are the spec's prose now,
    // not a compiled section graph.
    const result = validateLedger(ledger({ requiredAudience: ["developer"], reportSections: [{ scope: "module", audience: "developer", sectionId: "coverage" }] }));
    expect(result).toEqual({ ok: true });
  });

  it("does not require report sections for a must-print item outside the M3 facet", () => {
    // an M1 structural must-print item asserts it is found in structure; its report
    // routing is pinned by the M3 items, not required here.
    const result = validateLedger(ledger({ facets: ["M1"], mustPrint: true, criticality: "critical" }));
    expect(result).toEqual({ ok: true });
  });
});
