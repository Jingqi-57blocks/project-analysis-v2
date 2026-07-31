import { describe, expect, it } from "vitest";

import {
  activationFromObservation,
  ACTIVATION_STATES,
} from "../../../engine/contracts/shared-fact/activation.js";

describe("activationFromObservation", () => {
  it("fails closed to unresolved when production state is unobservable", () => {
    expect(activationFromObservation({ observable: false, conditional: false })).toBe("unresolved");
    // Unobservable dominates: we cannot claim conditional either.
    expect(activationFromObservation({ observable: false, conditional: true })).toBe("unresolved");
  });

  it("distinguishes conditional from active when observable", () => {
    expect(activationFromObservation({ observable: true, conditional: true })).toBe("conditional");
    expect(activationFromObservation({ observable: true, conditional: false })).toBe("active");
  });

  it("exposes the three states", () => {
    expect(ACTIVATION_STATES).toEqual(["active", "conditional", "unresolved"]);
  });
});
