import { describe, expect, it } from "vitest";

import {
  MODULE_CLASSIFICATION_SCHEMA_VERSION,
  type ClassifiedCandidate,
  type ClassifierIdentity,
  type ModuleCandidate,
  type ModuleClassificationArtifact,
  artifactIdentity,
  candidateSetDigest,
  moduleScopeCandidates,
  shouldReuse,
  unresolvedArtifact,
  validateClassificationResult,
} from "../../../engine/contracts/module-classification/schema.js";

function candidate(id: string, refs: readonly string[] = [`fact:symbol:${id}`]): ModuleCandidate {
  return {
    candidateId: id,
    displayNameCandidates: [id, id.toUpperCase()],
    memberSummary: `${id} members`,
    entrySummary: [`/${id}`],
    relationSummary: [`table:${id}`],
    evidenceRefs: refs,
    reason: `formed from ${id}`,
  };
}

function classified(
  id: string,
  classification: ClassifiedCandidate["classification"],
  over: Partial<ClassifiedCandidate> = {},
): ClassifiedCandidate {
  return {
    candidateId: id,
    classification,
    confidence: 0.9,
    reason: `${id} is ${classification}`,
    evidenceRefs: [`fact:symbol:${id}`],
    status: classification === "unresolved" ? "unresolved" : "classified",
    ...over,
  };
}

const classifier: ClassifierIdentity = { executor: "agent", model: "claude-x", contractVersion: "v1" };

function artifact(
  candidates: readonly ModuleCandidate[],
  results: readonly ClassifiedCandidate[],
  over: Partial<ModuleClassificationArtifact> = {},
): ModuleClassificationArtifact {
  return {
    schemaVersion: MODULE_CLASSIFICATION_SCHEMA_VERSION,
    sourceSnapshotId: "snap-1",
    candidateSetDigest: candidateSetDigest(candidates),
    classifier,
    candidates: results,
    ...over,
  };
}

describe("candidateSetDigest", () => {
  it("is order-independent across candidates", () => {
    const a = [candidate("a"), candidate("b"), candidate("c")];
    const b = [candidate("c"), candidate("a"), candidate("b")];
    expect(candidateSetDigest(a)).toBe(candidateSetDigest(b));
  });

  it("changes when a candidate's content changes", () => {
    const base = [candidate("a")];
    const changed = [{ ...candidate("a"), reason: "different reason" }];
    expect(candidateSetDigest(base)).not.toBe(candidateSetDigest(changed));
  });
});

describe("shouldReuse", () => {
  const candidates = [candidate("a"), candidate("b")];
  const digest = candidateSetDigest(candidates);
  const existing = artifact(candidates, [classified("a", "product-module"), classified("b", "technical-component")]);

  it("reuses when digest, schema and classifier all match", () => {
    expect(shouldReuse(existing, digest, classifier)).toBe(true);
  });

  it("does not reuse when the candidate set changed", () => {
    const changed = candidateSetDigest([candidate("a"), candidate("b"), candidate("c")]);
    expect(shouldReuse(existing, changed, classifier)).toBe(false);
  });

  it("does not reuse when the classifier model changed", () => {
    expect(shouldReuse(existing, digest, { ...classifier, model: "claude-y" })).toBe(false);
  });

  it("does not reuse when the contract version changed", () => {
    expect(shouldReuse(existing, digest, { ...classifier, contractVersion: "v2" })).toBe(false);
  });

  it("does not reuse across a schema version change", () => {
    expect(shouldReuse({ ...existing, schemaVersion: "module-classification.v0" }, digest, classifier)).toBe(false);
  });
});

describe("artifactIdentity (overrides participate)", () => {
  it("differs when an override is added", () => {
    const candidates = [candidate("a")];
    const without = artifact(candidates, [classified("a", "product-module")]);
    const withOverride = artifact(candidates, [
      classified("a", "external-system", {
        override: { source: "reviewer@x", classification: "external-system", note: "third-party" },
      }),
    ]);
    expect(artifactIdentity(without)).not.toBe(artifactIdentity(withOverride));
  });
});

describe("validateClassificationResult (fail closed)", () => {
  const candidates = [candidate("a"), candidate("b")];

  it("accepts a well-formed result unchanged", () => {
    const art = artifact(candidates, [classified("a", "product-module"), classified("b", "external-system")]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(true);
    expect(v.diagnostics).toEqual([]);
    expect(v.normalized.candidates.map((c) => c.classification)).toEqual(["product-module", "external-system"]);
  });

  it("drops an invented candidate id and marks the real one unclassified", () => {
    const art = artifact(candidates, [classified("a", "product-module"), classified("ghost", "product-module")]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.candidateId === "ghost")).toBe(true);
    // b was never classified -> coerced unresolved, never a module
    expect(v.normalized.candidates.find((c) => c.candidateId === "b")!.classification).toBe("unresolved");
  });

  it("coerces a missing candidate to unresolved", () => {
    const art = artifact(candidates, [classified("a", "product-module")]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.normalized.candidates.find((c) => c.candidateId === "b")!.status).toBe("unresolved");
  });

  it("coerces a duplicate classification to unresolved", () => {
    const art = artifact(candidates, [
      classified("a", "product-module"),
      classified("a", "technical-component"),
      classified("b", "product-module"),
    ]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.normalized.candidates.find((c) => c.candidateId === "a")!.classification).toBe("unresolved");
  });

  it("coerces an invalid label to unresolved", () => {
    const art = artifact(candidates, [
      classified("a", "banana" as unknown as ClassifiedCandidate["classification"]),
      classified("b", "product-module"),
    ]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.normalized.candidates.find((c) => c.candidateId === "a")!.classification).toBe("unresolved");
  });

  it("coerces a classification with no evidence refs to unresolved", () => {
    const art = artifact(candidates, [
      classified("a", "product-module", { evidenceRefs: [] }),
      classified("b", "product-module"),
    ]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.normalized.candidates.find((c) => c.candidateId === "a")!.classification).toBe("unresolved");
  });

  it("coerces a classification whose evidence refs are not on the candidate", () => {
    const art = artifact(candidates, [
      classified("a", "product-module", { evidenceRefs: ["fact:invented:z"] }),
      classified("b", "product-module"),
    ]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.normalized.candidates.find((c) => c.candidateId === "a")!.classification).toBe("unresolved");
  });

  it("rejects a result whose digest does not match the candidate set", () => {
    const art = artifact(candidates, [classified("a", "product-module"), classified("b", "product-module")], {
      candidateSetDigest: "deadbeef",
    });
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.reason.includes("candidateSetDigest"))).toBe(true);
  });

  it("coerces an out-of-range confidence to unresolved", () => {
    const art = artifact(candidates, [
      classified("a", "product-module", { confidence: 1.5 }),
      classified("b", "product-module"),
    ]);
    const v = validateClassificationResult(candidates, art);
    expect(v.ok).toBe(false);
    expect(v.normalized.candidates.find((c) => c.candidateId === "a")!.classification).toBe("unresolved");
  });
});

describe("unresolvedArtifact (AI failure fails closed)", () => {
  it("marks every candidate unresolved so a failed run scopes no module", () => {
    const candidates = [candidate("a"), candidate("b")];
    const art = unresolvedArtifact(candidates, "snap-1", classifier, "classifier call failed");
    expect(art.candidates.every((c) => c.classification === "unresolved" && c.status === "unresolved")).toBe(true);
    expect(art.candidateSetDigest).toBe(candidateSetDigest(candidates));
    expect(moduleScopeCandidates(art)).toEqual([]);
    // and it validates as a well-formed (if all-unresolved) result over the set
    expect(validateClassificationResult(candidates, art).ok).toBe(true);
  });
});

describe("moduleScopeCandidates", () => {
  it("keeps only classified product-module and technical-component", () => {
    const candidates = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
    const art = artifact(candidates, [
      classified("a", "product-module"),
      classified("b", "technical-component"),
      classified("c", "external-system"),
      classified("d", "unresolved"),
    ]);
    const scope = moduleScopeCandidates(art);
    expect(scope.map((c) => c.candidateId)).toEqual(["a", "b"]);
  });
});
