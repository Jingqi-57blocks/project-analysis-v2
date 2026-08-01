import { describe, expect, it } from "vitest";

import { behaviorInputFrom } from "../../engine/kb/behavior-input.js";

describe("behaviorInputFrom — the bridge from extracted evidence to the behaviour derivers", () => {
  it("produces a well-formed input, with the not-yet-extracted families disclosed empty", () => {
    // Over no roots the bridge still returns the full five-part shape, so a real run
    // always has a complete input. The families no generic extractor produces yet —
    // notification calls, external calls, state transitions and test relations — are
    // empty by disclosure, not by a name whitelist.
    const input = behaviorInputFrom([]);

    expect(input.decisions.conditions).toEqual([]);
    expect(input.decisions.valueSets).toEqual([]);
    expect(input.boundary.auth).toEqual([]);
    expect(input.boundary.validations).toEqual([]);
    expect(input.sideEffects.dataAccess).toEqual([]);
    expect(input.sideEffects.transactions).toEqual([]);
    expect(input.sideEffects.outbound).toEqual([]);

    // the disclosed-empty families
    expect(input.sideEffects.notifications).toEqual([]);
    expect(input.sideEffects.external).toEqual([]);
    expect(input.states.changes).toBeUndefined();
    expect(input.tests.testRelations).toEqual([]);
    expect(input.tests.providerRan).toBe(false);
  });
});
