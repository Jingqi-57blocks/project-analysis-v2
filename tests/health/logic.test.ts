import { describe, expect, it } from "vitest";

import { computeLogicFindings, findDivergence } from "../../engine/health/logic.js";
import type { BusinessRule } from "../../engine/semantics/rules.js";

function rule(overrides: Partial<BusinessRule>): BusinessRule {
  return {
    rootName: "a",
    subject: "leave.Hours",
    operator: ">",
    literal: 40,
    statement: "hours is more than 40",
    meanings: [],
    valueSetName: null,
    relPath: "svc.go",
    startLine: 1,
    text: "leave.Hours > 40",
    guarded: null,
    enclosingFunction: null,
    ...overrides,
  };
}

describe("findDivergence", () => {
  it("finds a boundary two parts draw differently, however they name the field", () => {
    // Two parts rarely name a thing alike; grouping on the whole name finds
    // nothing, which is how the real disagreement went unreported.
    const divergent = findDivergence([
      rule({ rootName: "a", subject: "leave.Hours", operator: ">" }),
      rule({ rootName: "b", subject: "takeHours", operator: ">=" }),
    ]);

    expect(divergent).toHaveLength(1);
    expect(divergent[0]!.variants).toHaveLength(2);
  });

  it("says nothing when one part uses both spellings", () => {
    expect(
      findDivergence([
        rule({ rootName: "a", operator: ">" }),
        rule({ rootName: "a", operator: ">=" }),
      ]),
    ).toEqual([]);
  });

  it("does not let a third part legitimise one part's internal split", () => {
    const divergent = findDivergence([
      rule({ rootName: "a", operator: ">" }),
      rule({ rootName: "a", operator: ">=" }),
      rule({ rootName: "b", operator: ">" }),
    ]);
    expect(divergent).toEqual([]);
  });

  it("is not a contradiction when one asks equality and the other inequality", () => {
    expect(
      findDivergence([
        rule({ rootName: "a", operator: "==" }),
        rule({ rootName: "b", operator: "!=" }),
      ]),
    ).toEqual([]);
  });

  it("does not pair two counters that share only a classifier word", () => {
    // A row-merge counter and a trip counter both end in "count"; they are two
    // counters, not one rule applied twice.
    expect(
      findDivergence([
        rule({ rootName: "a", subject: "mergeRowCount", operator: ">=", literal: 1 }),
        rule({ rootName: "b", subject: "returnCount", operator: ">", literal: 1 }),
      ]),
    ).toEqual([]);
  });
});

describe("computeLogicFindings", () => {
  const variants = [
    rule({ rootName: "a", subject: "leave.Hours", operator: ">" }),
    rule({ rootName: "b", subject: "takeHours", operator: ">=" }),
  ];

  it("reports a disagreement to the capability that owns either spelling", () => {
    // Keyed differently on each side, the finding vanished depending on which
    // spelling happened to come first.
    for (const owned of [variants[0]!, variants[1]!]) {
      const found = computeLogicFindings({
        featureId: "f",
        featureName: "Leave",
        rules: [owned],
        discarded: [],
        allRules: variants,
      });
      expect(found.some((f) => f.id === "rule-applied-two-ways")).toBe(true);
    }
  });

  it("names both spellings so a reader can check they mean the same thing", () => {
    const found = computeLogicFindings({
      featureId: "f",
      featureName: "Leave",
      rules: [variants[0]!],
      discarded: [],
      allRules: variants,
    });
    const finding = found.find((f) => f.id === "rule-applied-two-ways")!;
    expect(finding.finding).toContain("leave.Hours");
    expect(finding.finding).toContain("takeHours");
    expect(finding.severity).toBe("concern");
  });

  it("says nothing about a capability with nothing to say", () => {
    expect(
      computeLogicFindings({
        featureId: "f",
        featureName: "Leave",
        rules: [rule({ meanings: ["approved"], valueSetName: "S" })],
        discarded: [],
        allRules: [],
      }),
    ).toEqual([]);
  });
});
