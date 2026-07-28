import { describe, expect, it } from "vitest";

import {
  declared,
  fileRef,
  inferred,
  isDirectlyObserved,
  lineRef,
  resolved,
  unresolved,
} from "../../engine/structural/provenance.js";

const ref = lineRef("svc", "user/service.go", 40, 52);

describe("source references", () => {
  it("records a whole-file fact with a null range rather than a fabricated line 1", () => {
    // Pointing a reader at line 1 of a manifest to explain a dependency would
    // send them somewhere that says nothing.
    expect(fileRef("svc", "go.mod")).toEqual({
      rootName: "svc",
      relPath: "go.mod",
      startLine: null,
      endLine: null,
      startColumn: null,
      endColumn: null,
    });
  });

  it("defaults a single-line reference to end where it starts", () => {
    expect(lineRef("svc", "a.go", 12)).toMatchObject({ startLine: 12, endLine: 12 });
  });

  it("identifies the root by name, not by absolute path", () => {
    // A knowledge base full of machine-specific paths could not be compared
    // across runs or shared.
    expect(ref.rootName).toBe("svc");
    expect(ref.relPath).not.toContain("/Users");
  });
});

describe("provenance constructors", () => {
  it("gives a declared fact no confidence field at all", () => {
    const provenance = declared(ref);
    expect(provenance.resolutionClass).toBe("declared");
    // Not "high" — attaching a confidence to something read verbatim would
    // blur the line between read and guessed well.
    expect("confidence" in provenance).toBe(false);
  });

  it("lets a resolved fact carry a confidence or none", () => {
    expect(resolved(ref)).toMatchObject({ resolutionClass: "resolved", confidence: null });
    expect(resolved(ref, "high")).toMatchObject({ confidence: "high" });
  });

  it("requires a confidence on an inferred fact", () => {
    expect(inferred(ref, "low")).toMatchObject({ resolutionClass: "inferred", confidence: "low" });
  });

  it("requires a reason on an unresolved fact", () => {
    // "Unknown" with no reason is indistinguishable from "not attempted", and
    // the two call for different responses.
    const provenance = unresolved(ref, "URL built from configuration at runtime");
    expect(provenance).toMatchObject({
      resolutionClass: "unresolved",
      unresolvedReason: "URL built from configuration at runtime",
    });
  });
});

describe("isDirectlyObserved", () => {
  it("accepts declared and resolved facts", () => {
    expect(isDirectlyObserved(declared(ref))).toBe(true);
    expect(isDirectlyObserved(resolved(ref))).toBe(true);
  });

  it("rejects an inference even at high confidence", () => {
    // A consumer asserting a system has exactly N endpoints filters on this
    // rather than on confidence: a confident guess is still a guess.
    expect(isDirectlyObserved(inferred(ref, "high"))).toBe(false);
  });

  it("rejects an unresolved fact", () => {
    expect(isDirectlyObserved(unresolved(ref, "dynamic dispatch"))).toBe(false);
  });
});
