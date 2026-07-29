import { describe, expect, it } from "vitest";

import { valueSetsIn } from "../../engine/semantics/enums.js";
import { isUnexplained, readableMember, stateRule } from "../../engine/semantics/rules.js";
import { resolved } from "../../engine/structural/provenance.js";
import type { ConditionRecord } from "../../engine/structural/rules.js";

const sets = valueSetsIn(
  "svc",
  "constant/order.go",
  `package constant

const (
	OrderDraftC OrderStatusC = iota + 1
	OrderPlacedC
	OrderShippedC
	OrderDeliveredC
)
`,
);

function condition(overrides: Partial<ConditionRecord>): ConditionRecord {
  const source = {
    rootName: "svc",
    relPath: "svc/handler.go",
    startLine: 12,
    endLine: 12,
    startColumn: 1,
    endColumn: null,
  };
  return {
    rootName: "svc",
    subject: "order.Status",
    operator: "==",
    literal: 2,
    literalKind: "numeric",
    text: "order.Status == 2",
    enclosingFunction: "Handle",
    guarded: null,
    source,
    provenance: resolved(source, "high"),
    ...overrides,
  };
}

describe("stateRule", () => {
  it("names the value a project declares instead of repeating the number", () => {
    const rule = stateRule(condition({}), sets);
    expect(rule.statement).toBe("status is placed");
    expect(rule.meanings).toEqual(["placed"]);
    expect(rule.valueSetName).toBe("OrderStatusC");
    expect(isUnexplained(rule)).toBe(false);
  });

  it("words a negation as one", () => {
    expect(stateRule(condition({ operator: "!=" }), sets).statement).toBe("status is not placed");
  });

  it("names the states an ordered comparison admits, since a threshold names none", () => {
    // "status is more than 2" tells a reader nothing about which states those
    // are; the point of the enum is that it can say.
    const rule = stateRule(condition({ operator: ">", literal: 2 }), sets);
    expect(rule.statement).toBe("status is shipped or delivered");
    expect(rule.meanings).toEqual(["shipped", "delivered"]);
  });

  it("keeps the number when a comparison admits every declared value", () => {
    // Naming all four would read as a rule when it excludes nothing.
    expect(stateRule(condition({ operator: ">", literal: 0 }), sets).statement).toBe(
      "status is more than 0",
    );
  });

  it("shows a value nothing explains as written, and marks it", () => {
    const rule = stateRule(condition({ subject: "request.Hours", operator: ">", literal: 16 }), sets);

    expect(rule.statement).toBe("hours is more than 16");
    expect(rule.meanings).toEqual([]);
    expect(rule.valueSetName).toBeNull();
    expect(isUnexplained(rule)).toBe(true);
  });

  it("quotes a string value so it reads as a value rather than a word", () => {
    const rule = stateRule(
      condition({ subject: "leave.Kind", operator: "==", literal: "sick", literalKind: "string" }),
      sets,
    );
    expect(rule.statement).toBe('kind is "sick"');
  });

  it("keeps the location so the rule can be checked against the source", () => {
    const rule = stateRule(condition({}), sets);
    expect(rule.relPath).toBe("svc/handler.go");
    expect(rule.startLine).toBe(12);
    expect(rule.text).toBe("order.Status == 2");
  });
});

describe("readableMember", () => {
  it("turns a declared constant into words", () => {
    expect(readableMember("OrderDraftC", "OrderStatusC")).toBe("draft");
    expect(readableMember("OrderDraftC")).toBe("order draft");
    expect(readableMember("waiting_l1_approve")).toBe("waiting l1 approve");
    expect(readableMember("PLACED")).toBe("placed");
  });
});
