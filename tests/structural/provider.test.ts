import { describe, expect, it } from "vitest";

import { runPreflight, requireAvailable } from "../../engine/providers/preflight.js";
import { ProviderUnavailableError } from "../../engine/providers/types.js";
import { emptyRecords } from "../../engine/structural/kinds.js";
import {
  ANY_LANGUAGE,
  capabilityFor,
  declaredKinds,
  supports,
  type ProviderCapabilities,
  type StructuralProvider,
} from "../../engine/structural/provider.js";

const capabilities: ProviderCapabilities = {
  declarations: [
    { kind: "symbol", language: ANY_LANGUAGE, support: "full", limits: [] },
    { kind: "route", language: ANY_LANGUAGE, support: "none", limits: ["no framework knowledge"] },
    { kind: "route", language: "go", support: "partial", limits: ["misses group-prefixed routes"] },
    { kind: "call-edge", language: "go", support: "full", limits: [] },
  ],
};

describe("capabilityFor", () => {
  it("prefers an exact language match over the any-language declaration", () => {
    expect(capabilityFor(capabilities, "route", "go")?.support).toBe("partial");
  });

  it("falls back to the any-language declaration when the language is not named", () => {
    expect(capabilityFor(capabilities, "route", "swift")?.support).toBe("none");
  });

  it("returns null when the provider said nothing about a kind", () => {
    // Distinct from a declared "none": silence means the question was never
    // considered, which is a different state from a considered refusal.
    expect(capabilityFor(capabilities, "data-access", "go")).toBeNull();
  });

  it("carries the limits alongside the support level", () => {
    expect(capabilityFor(capabilities, "route", "go")?.limits).toEqual([
      "misses group-prefixed routes",
    ]);
  });
});

describe("supports", () => {
  it("is true for full and partial support", () => {
    expect(supports(capabilities, "symbol", "go")).toBe(true);
    expect(supports(capabilities, "route", "go")).toBe(true);
  });

  it("is false for a declared none", () => {
    expect(supports(capabilities, "route", "swift")).toBe(false);
  });

  it("is false when nothing was declared at all", () => {
    expect(supports(capabilities, "data-access", "go")).toBe(false);
  });
});

describe("declaredKinds", () => {
  it("derives the coarse kind list, excluding kinds declared as unsupported", () => {
    // Derived rather than hand-written so the coarse and detailed views cannot
    // disagree — a provider claiming a kind it declared no support for would
    // be exactly the silent mismatch the contract exists to prevent.
    expect(declaredKinds(capabilities)).toEqual(["call-edge", "route", "symbol"]);
  });

  it("keeps a kind supported for one language even when unsupported for another", () => {
    // "route" is none for any-language but partial for Go — dropping it would
    // understate what the provider can do.
    expect(declaredKinds(capabilities)).toContain("route");
  });

  it("returns nothing for a provider that declares nothing", () => {
    expect(declaredKinds({ declarations: [] })).toEqual([]);
  });
});

describe("StructuralProvider and the existing preflight registry", () => {
  function fakeStructuralProvider(id: string, available: boolean): StructuralProvider {
    return {
      id,
      version: "1.0.0",
      capabilities: () => declaredKinds(capabilities),
      preflight: () =>
        available ? { available: true, version: "1.0.0" } : { available: false, reason: "not installed" },
      structuralCapabilities: () => capabilities,
      extract: (root) => ({
        providerId: id,
        providerVersion: "1.0.0",
        rootName: root.name,
        records: emptyRecords(),
        gaps: [],
        failures: [],
      }),
    };
  }

  it("passes through preflight unchanged, so the registry needed no new machinery", () => {
    const report = runPreflight([fakeStructuralProvider("cg", true)]);
    expect(report.results).toEqual([{ id: "cg", available: true, version: "1.0.0" }]);
    expect(() => requireAvailable(report, ["cg"])).not.toThrow();
  });

  it("refuses a required structural provider that is unavailable", () => {
    const report = runPreflight([fakeStructuralProvider("cg", false)]);
    expect(() => requireAvailable(report, ["cg"])).toThrow(ProviderUnavailableError);
  });

  it("produces a contribution attributed to itself, for the root it was given", () => {
    const provider = fakeStructuralProvider("cg", true);
    const contribution = provider.extract({ name: "svc", path: "/tmp/svc", analyzedFiles: [] });

    expect(contribution.providerId).toBe("cg");
    expect(contribution.providerVersion).toBe("1.0.0");
    expect(contribution.rootName).toBe("svc");
  });
});
