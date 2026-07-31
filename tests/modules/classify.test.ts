import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SymbolId } from "../../engine/structural/identity.js";
import type { ProductModule, TechnicalComponent } from "../../engine/modules/form.js";
import type { ExternalSystemObservation, CandidateInput } from "../../engine/modules/candidates.js";
import { generateModuleCandidates } from "../../engine/modules/candidates.js";
import { classifyModuleCandidates, type Classifier } from "../../engine/modules/classify.js";
import {
  type ClassifiedCandidate,
  type ClassifierIdentity,
  moduleScopeCandidates,
} from "../../engine/contracts/module-classification/schema.js";
import { readClassificationArtifact } from "../../engine/modules/classification-store.js";

const sym = (s: string): SymbolId => s as unknown as SymbolId;

const productModule: ProductModule = {
  id: "mod_1",
  name: "leave",
  entryKeys: ["svc:/leave"],
  rootNames: ["svc"],
  symbolIds: [sym("a")],
  groupingSignal: "route prefix",
};
const component: TechnicalComponent = { id: "cmp_1", name: "authMiddleware", rootName: "svc", signals: ["auth"], memberPaths: ["mw/auth.go"] };
const external: ExternalSystemObservation = {
  key: "pay-host",
  displayNameCandidates: ["PaymentGateway"],
  targets: ["POST /charge"],
  evidenceRefs: ["fact:outbound:pay-host:charge"],
  reason: "calls a host outside the roots",
};
const ambiguous: TechnicalComponent = { id: "cmp_2", name: "misc", rootName: "svc", signals: ["shared"], memberPaths: ["misc.go"] };

const input: CandidateInput = { modules: [productModule], components: [component, ambiguous], externalSystems: [external] };
const classifier: ClassifierIdentity = { executor: "agent", model: "m", contractVersion: "v1" };

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "pi79-classify-"));
}

/** A classifier that labels each candidate by its id prefix, and counts its calls. */
function countingClassifier(): { fn: Classifier; calls: () => number } {
  let calls = 0;
  const fn: Classifier = (candidates) => {
    calls += 1;
    return candidates.map((c): ClassifiedCandidate => {
      const classification = c.candidateId.startsWith("mod_")
        ? "product-module"
        : c.candidateId.startsWith("ext_")
          ? "external-system"
          : c.candidateId === "cmp_2"
            ? "unresolved" // the ambiguous one
            : "technical-component";
      return {
        candidateId: c.candidateId,
        classification,
        confidence: 0.9,
        reason: `by prefix of ${c.candidateId}`,
        evidenceRefs: classification === "unresolved" ? [] : [c.evidenceRefs[0]!],
        status: classification === "unresolved" ? "unresolved" : "classified",
      };
    });
  };
  return { fn, calls: () => calls };
}

describe("classifyModuleCandidates", () => {
  it("classifies a mixed set, each result traceable to the candidate's evidence refs", async () => {
    const dir = runDir();
    const { fn } = countingClassifier();
    const out = await classifyModuleCandidates(input, { runDir: dir, sourceSnapshotId: "snap", classifier, classify: fn });

    const labels = Object.fromEntries(out.artifact.candidates.map((c) => [c.candidateId, c.classification]));
    expect(labels["mod_1"]).toBe("product-module");
    expect(labels["cmp_1"]).toBe("technical-component");
    expect(labels["cmp_2"]).toBe("unresolved"); // ambiguous -> unresolved, never a module
    expect(Object.values(labels)).toContain("external-system");

    const candidates = generateModuleCandidates(input);
    for (const result of out.artifact.candidates) {
      if (result.classification === "unresolved") continue;
      const cand = candidates.find((c) => c.candidateId === result.candidateId)!;
      for (const ref of result.evidenceRefs) expect(cand.evidenceRefs).toContain(ref);
    }

    // only product-module/technical-component reach module scope
    expect(moduleScopeCandidates(out.artifact).map((c) => c.candidateId).sort()).toEqual(["cmp_1", "mod_1"]);
  });

  it("reuses the prior artifact on a second identical run — the classifier is not called again", async () => {
    const dir = runDir();
    const first = countingClassifier();
    const a = await classifyModuleCandidates(input, { runDir: dir, sourceSnapshotId: "snap", classifier, classify: first.fn });
    expect(a.reused).toBe(false);
    expect(first.calls()).toBe(1);

    const second = countingClassifier();
    const b = await classifyModuleCandidates(input, { runDir: dir, sourceSnapshotId: "snap", classifier, classify: second.fn });
    expect(b.reused).toBe(true);
    expect(second.calls()).toBe(0); // no AI re-run
    expect(b.artifact.candidates.map((c) => c.classification)).toEqual(a.artifact.candidates.map((c) => c.classification));
  });

  it("re-classifies when the classifier identity changes", async () => {
    const dir = runDir();
    const first = countingClassifier();
    await classifyModuleCandidates(input, { runDir: dir, sourceSnapshotId: "snap", classifier, classify: first.fn });

    const second = countingClassifier();
    const changed = await classifyModuleCandidates(input, {
      runDir: dir,
      sourceSnapshotId: "snap",
      classifier: { ...classifier, model: "m2" },
      classify: second.fn,
    });
    expect(changed.reused).toBe(false);
    expect(second.calls()).toBe(1);
  });

  it("fails closed to all-unresolved when the classifier throws, and persists that", async () => {
    const dir = runDir();
    const out = await classifyModuleCandidates(input, {
      runDir: dir,
      sourceSnapshotId: "snap",
      classifier,
      classify: () => {
        throw new Error("model timeout");
      },
    });
    expect(out.artifact.candidates.every((c) => c.classification === "unresolved")).toBe(true);
    expect(moduleScopeCandidates(out.artifact)).toEqual([]);
    expect(readClassificationArtifact(dir)!.candidates.every((c) => c.classification === "unresolved")).toBe(true);
  });

  it("coerces a classifier that invents a module label with no evidence to unresolved", async () => {
    const dir = runDir();
    const out = await classifyModuleCandidates(input, {
      runDir: dir,
      sourceSnapshotId: "snap",
      classifier,
      classify: (candidates) =>
        candidates.map((c) => ({
          candidateId: c.candidateId,
          classification: "product-module" as const,
          confidence: 0.99,
          reason: "everything is a module",
          evidenceRefs: [], // no grounding -> fails closed
          status: "classified" as const,
        })),
    });
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(out.artifact.candidates.every((c) => c.classification === "unresolved")).toBe(true);
  });

  it("applies an explicit override and folds it into the result, not silently", async () => {
    const dir = runDir();
    const { fn } = countingClassifier();
    const out = await classifyModuleCandidates(input, {
      runDir: dir,
      sourceSnapshotId: "snap",
      classifier,
      classify: fn,
      overrides: [{ candidateId: "cmp_2", override: { source: "reviewer@x", classification: "product-module", note: "confirmed a real module" } }],
    });
    const overridden = out.artifact.candidates.find((c) => c.candidateId === "cmp_2")!;
    expect(overridden.classification).toBe("product-module");
    expect(overridden.status).toBe("classified");
    expect(overridden.override?.source).toBe("reviewer@x");
    // the override promotes cmp_2 into module scope
    expect(moduleScopeCandidates(out.artifact).map((c) => c.candidateId)).toContain("cmp_2");
  });
});
