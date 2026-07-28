import { describe, expect, it } from "vitest";

import { computeSignals, findRootCycles, type HealthInput } from "../../engine/health/signals.js";
import type { LinkResult } from "../../engine/linking/types.js";
import { inferred, lineRef } from "../../engine/structural/provenance.js";

function link(from: string, to: string) {
  return {
    fromRoot: from,
    fromSymbolId: null,
    target: `https://${to}/x`,
    toRoot: to,
    toMethod: "GET",
    toPath: "/x",
    toHandlerSymbolId: null,
    kind: "http-route",
    provenance: inferred(lineRef(from, "a.ts", 1), "medium"),
  };
}

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  const links: LinkResult = { links: [], unlinked: [], considered: 0 };
  return {
    links,
    traces: [],
    untracedEntryPoints: 0,
    modules: [],
    components: [],
    dispositions: {
      behavioralSource: 0,
      technicalOnly: 0,
      sharedInfrastructure: 0,
      unclassified: 0,
      total: 0,
    },
    dependencies: [],
    rootNames: ["svc"],
    ...overrides,
  };
}

describe("findRootCycles", () => {
  it("finds two roots that call each other", () => {
    // A cycle between services couples their deployment and change cycles,
    // which is actionable in a way a symbol-level cycle usually is not.
    const cycles = findRootCycles({ links: [link("a", "b"), link("b", "a")], unlinked: [], considered: 2 });
    expect(cycles).toEqual([["a", "b"]]);
  });

  it("reports a mutual pair once, not twice", () => {
    const cycles = findRootCycles({
      links: [link("a", "b"), link("b", "a"), link("a", "b")],
      unlinked: [],
      considered: 3,
    });
    expect(cycles).toHaveLength(1);
  });

  it("does not report a one-way dependency as a cycle", () => {
    expect(findRootCycles({ links: [link("a", "b")], unlinked: [], considered: 1 })).toEqual([]);
  });
});

describe("computeSignals", () => {
  it("states a fact and its evidence for every signal", () => {
    for (const signal of computeSignals(input())) {
      expect(signal.finding.length).toBeGreaterThan(0);
      expect(signal.title.length).toBeGreaterThan(0);
    }
  });

  it("produces no composite score, so nothing hides which input moved", () => {
    const signals = computeSignals(input());
    expect(signals.some((s) => /overall|score|grade/i.test(s.id))).toBe(false);
  });

  it("raises a concern when most outbound calls cannot be linked", () => {
    const signals = computeSignals(
      input({
        links: {
          links: [],
          unlinked: Array.from({ length: 9 }, () => ({
            fromRoot: "a",
            fromSymbolId: null,
            target: null,
            reason: "target-not-resolved" as const,
            candidates: [],
            provenance: inferred(lineRef("a", "x.ts", 1), "low"),
          })),
          considered: 10,
        },
      }),
    );

    const signal = signals.find((s) => s.id === "unresolved-integrations")!;
    expect(signal.severity).toBe("concern");
    expect(signal.value).toBe(90);
  });

  it("says plainly when there was nothing to measure, rather than reporting zero problems", () => {
    // An empty project must not read as a healthy one.
    const signal = computeSignals(input()).find((s) => s.id === "unresolved-integrations")!;
    expect(signal.finding).toContain("No outbound calls");
  });

  it("flags services that call each other as a concern", () => {
    const signals = computeSignals(
      input({ links: { links: [link("a", "b"), link("b", "a")], unlinked: [], considered: 2 } }),
    );
    expect(signals.find((s) => s.id === "root-cycles")!.severity).toBe("concern");
  });

  it("reports how much code any behaviour reaches", () => {
    const signal = computeSignals(
      input({
        dispositions: {
          behavioralSource: 25,
          technicalOnly: 25,
          sharedInfrastructure: 25,
          unclassified: 25,
          total: 100,
        },
      }),
    ).find((s) => s.id === "behavioural-coverage")!;

    expect(signal.value).toBe(25);
    expect(signal.evidence.join(" ")).toContain("unclassified 25");
  });
});
