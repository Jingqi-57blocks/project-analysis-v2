import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../../engine/contracts/shared-fact/evidence.js";
import { contributingProviders } from "../../../engine/contracts/shared-fact/evidence.js";
import { VALID_ENVELOPE_EXAMPLE } from "../../../engine/contracts/shared-fact/examples.js";
import { declared, lineRef, resolved } from "../../../engine/contracts/shared-fact/provenance.js";

describe("fact envelope provenance chain", () => {
  it("traces a merged fact back to each provider's original evidence", () => {
    const env = VALID_ENVELOPE_EXAMPLE;
    expect(env.evidence).toHaveLength(2);
    expect(env.evidence.map((e) => e.attribution.providerId)).toEqual(["sourcefiles", "codegraph"]);
    expect(env.evidence[0]!.provenance.resolutionClass).toBe("declared");
    expect(env.evidence[1]!.provenance.resolutionClass).toBe("resolved");
  });

  it("keeps two providers' raw identities beside one canonical id", () => {
    const env = VALID_ENVELOPE_EXAMPLE;
    expect(env.rawIdentities.map((r) => r.providerId)).toEqual(["sourcefiles", "codegraph"]);
    // The canonical id is single and carries neither provider's native handle.
    expect(env.factId).not.toContain("node:918273");
  });
});

describe("contributingProviders", () => {
  it("lists each provider once, in first-seen order", () => {
    const src = lineRef("api", "x.go", 1);
    const records: readonly EvidenceRecord[] = [
      { attribution: { providerId: "a", providerVersion: "1" }, provenance: declared(src) },
      { attribution: { providerId: "b", providerVersion: "1" }, provenance: resolved(src, "high") },
      { attribution: { providerId: "a", providerVersion: "1" }, provenance: resolved(src, "low") },
    ];
    expect(contributingProviders(records)).toEqual(["a", "b"]);
  });
});
