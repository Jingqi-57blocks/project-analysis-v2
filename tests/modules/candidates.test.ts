import { describe, expect, it } from "vitest";

import type { SymbolId } from "../../engine/structural/identity.js";
import type { ProductModule, TechnicalComponent } from "../../engine/modules/form.js";
import {
  type ExternalSystemObservation,
  generateModuleCandidates,
} from "../../engine/modules/candidates.js";
import {
  candidateSetDigest,
  shouldReuse,
  type ClassifierIdentity,
} from "../../engine/contracts/module-classification/schema.js";

const sym = (s: string): SymbolId => s as unknown as SymbolId;

function productModule(id: string, name: string): ProductModule {
  return {
    id,
    name,
    entryKeys: [`svc:/${name}`, `svc:/${name}/detail`],
    rootNames: ["svc"],
    symbolIds: [sym("a"), sym("b")],
    groupingSignal: "shared route prefix",
  };
}

function component(id: string, name: string): TechnicalComponent {
  return { id, name, rootName: "svc", signals: ["auth middleware"], memberPaths: ["mw/auth.go"] };
}

function external(key: string, name: string): ExternalSystemObservation {
  return {
    key,
    displayNameCandidates: [name],
    targets: ["POST /charge", "GET /balance"],
    evidenceRefs: [`fact:outbound:${key}:charge`, `fact:outbound:${key}:balance`],
    reason: "code calls a host outside the project's roots",
  };
}

describe("generateModuleCandidates", () => {
  const input = {
    modules: [productModule("mod_1", "leave")],
    components: [component("cmp_1", "authMiddleware")],
    externalSystems: [external("payments.internal", "PaymentGateway")],
  };

  it("forms one candidate per module, component and external system", () => {
    const candidates = generateModuleCandidates(input);
    expect(candidates.map((c) => c.candidateId).sort()).toEqual([...candidates.map((c) => c.candidateId)].sort());
    expect(candidates).toHaveLength(3);
    expect(candidates.find((c) => c.candidateId === "mod_1")!.reason).toContain("grouped by");
  });

  it("is deterministic and stable-ordered — the same input digests identically twice", () => {
    const a = generateModuleCandidates(input);
    const b = generateModuleCandidates(input);
    expect(candidateSetDigest(a)).toBe(candidateSetDigest(b));
    expect(a.map((c) => c.candidateId)).toEqual([...a.map((c) => c.candidateId)].sort());
  });

  it("classifies external systems by structure, not by name — renaming the service keeps the candidate shape", () => {
    const a = generateModuleCandidates({ modules: [], components: [], externalSystems: [external("k1", "Stripe")] });
    const z = generateModuleCandidates({ modules: [], components: [], externalSystems: [external("k1", "AcmePay")] });
    // Same key, different display name: identical structure, only the name differs.
    expect(a[0]!.memberSummary).toBe(z[0]!.memberSummary);
    expect(a[0]!.entrySummary).toEqual(z[0]!.entrySummary);
    expect(a[0]!.candidateId).toBe(z[0]!.candidateId);
    expect(a[0]!.displayNameCandidates).not.toEqual(z[0]!.displayNameCandidates);
  });

  it("gives an external system a stable id derived from its boundary key", () => {
    const one = generateModuleCandidates({ modules: [], components: [], externalSystems: [external("host-a", "A")] });
    const two = generateModuleCandidates({ modules: [], components: [], externalSystems: [external("host-a", "A")] });
    expect(one[0]!.candidateId).toBe(two[0]!.candidateId);
    expect(one[0]!.candidateId.startsWith("ext_")).toBe(true);
  });

  it("always grounds a candidate in its own primary ref, even with no member evidence", () => {
    const bare: ExternalSystemObservation = { key: "x", displayNameCandidates: ["X"], targets: [], evidenceRefs: [], reason: "r" };
    const candidates = generateModuleCandidates({ modules: [], components: [], externalSystems: [bare] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidenceRefs).toContain("fact:boundary:x");
  });

  it("feeds reuse: an unchanged candidate set reuses a prior classification (no re-run)", () => {
    const classifier: ClassifierIdentity = { executor: "agent", model: "m", contractVersion: "v1" };
    const candidates = generateModuleCandidates(input);
    const digest = candidateSetDigest(candidates);
    const stored = {
      schemaVersion: "module-classification.v1",
      sourceSnapshotId: "snap",
      candidateSetDigest: digest,
      classifier,
      candidates: [],
    };
    // Second run over the same snapshot: same candidates, same digest -> reuse.
    const rerun = candidateSetDigest(generateModuleCandidates(input));
    expect(shouldReuse(stored, rerun, classifier)).toBe(true);
  });
});
