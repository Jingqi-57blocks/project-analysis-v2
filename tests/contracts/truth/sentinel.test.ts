import { describe, expect, it } from "vitest";

import {
  loadAngelsPizzaSentinels,
  noReaderSentinels,
  sentinelsByKind,
  validateSentinelLedger,
} from "../../../engine/contracts/truth/sentinel.js";

const ledger = loadAngelsPizzaSentinels();

describe("angels-pizza sentinels", () => {
  it("loads and validates", () => {
    const result = validateSentinelLedger(ledger);
    expect(result.ok, result.ok ? "" : result.reasons.join("; ")).toBe(true);
  });

  it("carries positive, negative and clean-absence — a report existing is not truth", () => {
    expect(sentinelsByKind(ledger, "positive").length).toBeGreaterThan(0);
    expect(sentinelsByKind(ledger, "negative").length).toBeGreaterThan(0);
    expect(sentinelsByKind(ledger, "clean-absence").length).toBeGreaterThan(0);
  });

  it("exercises the no-dedicated-reader roots with a real positive", () => {
    const nr = noReaderSentinels(ledger);
    expect(nr.length).toBeGreaterThan(0);
    expect(nr.some((i) => i.kind === "positive" && i.expectedStatus === "found")).toBe(true);
  });

  it("expects absent for every clean-absence sentinel", () => {
    for (const i of sentinelsByKind(ledger, "clean-absence")) expect(i.expectedStatus, i.id).toBe("absent");
  });

  it("is deterministic — a reload yields the same inventory", () => {
    expect(loadAngelsPizzaSentinels().items.map((i) => i.id)).toEqual(ledger.items.map((i) => i.id));
  });
});
