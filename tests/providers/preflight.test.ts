import { describe, expect, it } from "vitest";

import { runPreflight, requireAvailable } from "../../engine/providers/preflight.js";
import { ProviderUnavailableError, type Provider } from "../../engine/providers/types.js";

function fakeProvider(id: string, result: "available" | "unavailable" | "throws", version = "1.0.0"): Provider {
  return {
    id,
    version,
    capabilities: () => ["fake-capability"],
    preflight: () => {
      if (result === "throws") throw new Error(`${id} blew up during preflight`);
      return result === "available"
        ? { available: true, version }
        : { available: false, reason: `${id} is not installed` };
    },
  };
}

describe("runPreflight", () => {
  it("reports each provider's own availability and version", () => {
    const report = runPreflight([fakeProvider("a", "available", "2.3.4"), fakeProvider("b", "unavailable")]);

    expect(report.results).toEqual([
      { id: "a", available: true, version: "2.3.4" },
      { id: "b", available: false, reason: "b is not installed" },
    ]);
  });

  it("returns an empty report for no providers", () => {
    expect(runPreflight([]).results).toEqual([]);
  });

  it("isolates a provider whose preflight() itself throws", () => {
    const report = runPreflight([
      fakeProvider("good", "available"),
      fakeProvider("broken", "throws"),
      fakeProvider("also-good", "available"),
    ]);

    const broken = report.results.find((r) => r.id === "broken");
    expect(broken?.available).toBe(false);
    if (!broken?.available) expect(broken?.reason).toContain("blew up during preflight");

    // The other two providers are unaffected — one broken provider must not
    // corrupt the whole batch, the same isolation already proven for one
    // unreadable file in the inventory walker.
    expect(report.results.find((r) => r.id === "good")?.available).toBe(true);
    expect(report.results.find((r) => r.id === "also-good")?.available).toBe(true);
  });

  it("preserves provider order", () => {
    const report = runPreflight([
      fakeProvider("z", "available"),
      fakeProvider("a", "available"),
      fakeProvider("m", "available"),
    ]);
    expect(report.results.map((r) => r.id)).toEqual(["z", "a", "m"]);
  });
});

describe("requireAvailable", () => {
  it("passes silently when every required provider is available", () => {
    const report = runPreflight([fakeProvider("a", "available"), fakeProvider("b", "available")]);
    expect(() => requireAvailable(report, ["a", "b"])).not.toThrow();
  });

  it("passes when the required subset is available, ignoring providers not required", () => {
    const report = runPreflight([fakeProvider("a", "available"), fakeProvider("b", "unavailable")]);
    expect(() => requireAvailable(report, ["a"])).not.toThrow();
  });

  it("throws ProviderUnavailableError naming a missing required provider", () => {
    const report = runPreflight([fakeProvider("a", "unavailable")]);
    expect(() => requireAvailable(report, ["a"])).toThrow(ProviderUnavailableError);
  });

  it("names every missing required provider, each with its own reason", () => {
    const report = runPreflight([
      fakeProvider("a", "unavailable"),
      fakeProvider("b", "available"),
      fakeProvider("c", "unavailable"),
    ]);

    try {
      requireAvailable(report, ["a", "b", "c"]);
      expect.unreachable("expected requireAvailable to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      const err = error as ProviderUnavailableError;
      expect(err.missing.map((m) => m.id)).toEqual(["a", "c"]);
      expect(err.missing.map((m) => m.reason)).toEqual(["a is not installed", "c is not installed"]);
      expect(err.message).toContain("a is not installed");
      expect(err.message).toContain("c is not installed");
    }
  });

  it("does not block a run over a provider that is unavailable but not required", () => {
    const report = runPreflight([fakeProvider("optional", "unavailable"), fakeProvider("required", "available")]);
    expect(() => requireAvailable(report, ["required"])).not.toThrow();
  });

  it("treats a required provider that was never registered as missing, not as silently satisfied", () => {
    // A required id absent from the report at all is most likely a typo in
    // the caller's required-id list. Silently letting it through would hide
    // exactly the kind of mistake this project's other refusals exist to
    // surface (empty selection, schema too new, source drift mid-run).
    const report = runPreflight([fakeProvider("a", "available")]);

    expect(() => requireAvailable(report, ["a", "never-registered"])).toThrow(ProviderUnavailableError);

    try {
      requireAvailable(report, ["a", "never-registered"]);
    } catch (error) {
      const err = error as ProviderUnavailableError;
      expect(err.missing.map((m) => m.id)).toEqual(["never-registered"]);
      expect(err.missing[0]?.reason).toBe("provider not registered");
    }
  });

  it("treats a required provider whose preflight() threw the same as any other unavailable one", () => {
    const report = runPreflight([fakeProvider("flaky", "throws")]);
    expect(() => requireAvailable(report, ["flaky"])).toThrow(ProviderUnavailableError);
  });
});
