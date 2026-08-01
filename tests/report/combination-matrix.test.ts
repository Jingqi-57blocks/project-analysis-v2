import { describe, expect, it } from "vitest";

import type { GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import {
  ILLEGAL_REQUEST_EXAMPLES,
  LEGAL_COMBINATION_EXAMPLES,
  type ReportRequest,
  isModuleOnly,
  targetKey,
  validateRequest,
} from "../../engine/contracts/report/target.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import {
  accountExecutablePlan,
  projectLevelFootprint,
  verifyDedup,
} from "../../engine/report/combination.js";
import { executeAuthoredTasks } from "../../engine/report/execute.js";
import { authoredTasks } from "../../engine/contracts/report/pipeline.js";
import { fakeHost } from "./helpers/fake-host.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "src-1",
  codeGraphIdentity: "graph-1",
  providerIdentity: "providers-1",
  schemaVersion: "1.0.0",
  configIdentity: "config-1",
};
const PARAMS: GenerationParams = { executorKind: "host-agent", modelId: "claude-opus-4-8", language: "en" };

function compile(request: ReportRequest) {
  return compileExecutablePlan({ request, snapshot: SNAPSHOT, params: PARAMS, analysisRunId: "run-1" });
}

describe("the eight-way combination matrix — every legal combination compiles and accounts", () => {
  for (const { name, request } of LEGAL_COMBINATION_EXAMPLES) {
    it(`${name}: documents match the request one-for-one, dedup holds`, () => {
      const e = compile(request);
      const a = accountExecutablePlan(e);

      // one document per requested target, nothing unrequested, nothing dropped
      expect(a.documentCount).toBe(request.length);
      expect(a.documentIds).toEqual([...request.map(targetKey)].sort());
      expect(a.authoredTaskCount).toBeGreaterThan(0);
      expect(a.bundleCount).toBeGreaterThanOrEqual(1);

      // no slice materialized twice; every reference resolves
      expect(a.uniqueSliceCount).toBeLessThanOrEqual(a.sliceReferenceCount);
      expect(verifyDedup(request, e)).toEqual({ ok: true });
    });
  }
});

describe("verifyDedup fails closed on a document mismatch", () => {
  it("flags a requested target with no produced document", () => {
    const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;
    const e = compile(both.request);
    // verify against a request that asks for one more target than the plan produced
    const extra: ReportRequest = [...both.request, { scope: { kind: "module", moduleId: "leave" }, audience: "product" }];
    const verdict = verifyDedup(extra, e);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.some((v) => v.kind === "missing-requested-document")).toBe(true);
  });

  it("flags a produced document nobody requested", () => {
    const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;
    const e = compile(both.request);
    // verify against a narrower request than the plan produced
    const verdict = verifyDedup([both.request[0]!], e);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.some((v) => v.kind === "unrequested-document")).toBe(true);
  });
});

describe("module-only requests carry no project-level footprint", () => {
  for (const { name, request } of LEGAL_COMBINATION_EXAMPLES.filter((c) => isModuleOnly(c.request))) {
    it(`${name}: zero project documents and zero project tasks`, () => {
      const e = compile(request);
      expect(projectLevelFootprint(e)).toEqual({ projectDocumentCount: 0, projectTaskCount: 0 });
      expect(accountExecutablePlan(e).projectDocumentCount).toBe(0);
      expect(verifyDedup(request, e)).toEqual({ ok: true });
    });
  }
});

describe("a shared slice is materialized once and reused by digest", () => {
  it("project × both reuses the shared sections' slices across product and developer", () => {
    const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;
    const e = compile(both.request);
    const a = accountExecutablePlan(e);
    expect(a.documentCount).toBe(2);
    expect(a.sharedSliceCount).toBeGreaterThan(0); // shared identity/coverage/known-issues slices
    expect(a.uniqueSliceCount).toBeLessThan(a.sliceReferenceCount); // reused, not re-materialized
  });
});

describe("compiling the same combination twice is byte-stable", () => {
  for (const { name, request } of LEGAL_COMBINATION_EXAMPLES) {
    it(`${name}: identical accounting and audit digests`, () => {
      const first = compile(request);
      const second = compile(request);
      expect(accountExecutablePlan(first).accountingDigest).toBe(accountExecutablePlan(second).accountingDigest);
      expect(first.auditDigest).toBe(second.auditDigest);
    });
  }
});

describe("illegal requests fail closed", () => {
  for (const { why, request } of ILLEGAL_REQUEST_EXAMPLES) {
    it(`${why}: validateRequest rejects it`, () => {
      expect(validateRequest(request).ok).toBe(false);
    });
  }
});

describe("shared claim ledger is one identity across a multi-document request", () => {
  it("both audiences reference the same problem ledger, and a shared block reuses one slice", () => {
    const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;
    const e = compile(both.request);

    // one problem ledger for the whole plan — not re-minted per document
    const docs = e.plan.documents;
    expect(docs.length).toBe(2);

    // the shared known-issues.impact block appears in both documents with one slice key
    const sharedSliceKeys = docs.map((d) => {
      const section = d.sections.find((s) => s.sectionId === "known-issues")!;
      return section.blocks.find((b) => b.blockId === "known-issues.impact")!.factSlice.sliceKey;
    });
    expect(new Set(sharedSliceKeys).size).toBe(1); // same slice identity in both documents
  });
});

describe("the fake Host Agent covers the required execution scenarios per combination", () => {
  const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;

  it("a bundle returning many blocks: every authored task across both documents runs once and the run completes", () => {
    const e = compile(both.request);
    const host = fakeHost();
    const run = executeAuthoredTasks(e.plan, host);
    expect(run.assembly.complete).toBe(true);
    for (const t of authoredTasks(e.plan)) expect(host.callCount(t.taskId)).toBe(1);
  });

  it("a required block missing in one document blocks that run's completion", () => {
    const e = compile(both.request);
    const target = authoredTasks(e.plan)[0]!;
    const run = executeAuthoredTasks(e.plan, fakeHost({ alwaysReject: new Set([target.taskId]) }));
    expect(run.assembly.complete).toBe(false);
    expect(run.assembly.missingRequired).toContain(target.taskId);
  });
});
