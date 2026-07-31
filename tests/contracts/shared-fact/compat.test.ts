import { describe, expect, it } from "vitest";

import * as contractProvenance from "../../../engine/contracts/shared-fact/provenance.js";
import { joinKey as contractJoinKey } from "../../../engine/contracts/shared-fact/serialization.js";
import { symbolId } from "../../../engine/structural/identity.js";
import { joinKey as structuralJoinKey } from "../../../engine/structural/identity.js";
import * as structuralProvenance from "../../../engine/structural/provenance.js";

/**
 * The structural layer must be an adapter onto the shared-fact contract, not a
 * parallel copy. These assertions fail the moment a second definition drifts in.
 */
describe("structural provenance is the shared-fact contract", () => {
  it("re-exports the very same constructors and predicate", () => {
    expect(structuralProvenance.declared).toBe(contractProvenance.declared);
    expect(structuralProvenance.resolved).toBe(contractProvenance.resolved);
    expect(structuralProvenance.inferred).toBe(contractProvenance.inferred);
    expect(structuralProvenance.unresolved).toBe(contractProvenance.unresolved);
    expect(structuralProvenance.isDirectlyObserved).toBe(contractProvenance.isDirectlyObserved);
  });
});

describe("one canonical serialization underlies symbol and fact identity", () => {
  it("structural joinKey is the contract's joinKey", () => {
    expect(structuralJoinKey).toBe(contractJoinKey);
  });

  it("a symbol id is the same escaped join a fact id is built from", () => {
    // symbolId omits the family/kind prefix a FactId leads with, but both use
    // the same escaped join, so equivalent tails serialize identically.
    const sym = symbolId({
      rootName: "api",
      relPath: "x.go",
      kind: "func",
      qualifiedName: "F",
      signature: null,
    });
    expect(sym).toBe(contractJoinKey(["api", "x.go", "func", "F", null]));
  });
});
