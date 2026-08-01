import { describe, expect, it } from "vitest";

import { behaviorInputFrom } from "../../engine/kb/behavior-input.js";

describe("behaviorInputFrom — the bridge from extracted evidence to the behaviour derivers", () => {
  it("produces the full five-part input shape, with the not-yet-extracted families disclosed empty", () => {
    // Over no roots the bridge still returns the full five-part shape, so a real run
    // always has a complete input. Conditions, decisions, guards, rules, value sets,
    // auth, validations, error handling, data access, transactions, outbound and
    // notification calls are all wired (empty here only because there are no roots).
    const { input, notes } = behaviorInputFrom([]);

    // No index passed and no roots — reachability adds nothing and says so.
    expect(notes).toEqual(["notification-reachability: no code index available — no reverse-reachability attributed"]);
    expect(input.decisions.conditions).toEqual([]);
    expect(input.decisions.decisions).toEqual([]);
    expect(input.decisions.guards).toEqual([]);
    expect(input.decisions.rules).toEqual([]);
    expect(input.boundary.auth).toEqual([]);
    expect(input.sideEffects.notifications).toEqual([]); // wired to g.notifications

    // the two families no generic extractor produces yet — disclosed empty, not a whitelist
    expect(input.sideEffects.external).toEqual([]);
    expect(input.states.changes).toBeUndefined();
    expect(input.tests.testRelations).toEqual([]);
    expect(input.tests.providerRan).toBe(false);
  });
});
