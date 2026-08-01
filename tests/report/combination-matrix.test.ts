import { describe, expect, it } from "vitest";

import {
  type GenerationParams,
  type ProblemRecord,
  authoredTasks,
  problemId,
} from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import {
  ILLEGAL_REQUEST_EXAMPLES,
  LEGAL_COMBINATION_EXAMPLES,
  type Audience,
  type ReportRequest,
  type Scope,
  isModuleOnly,
  targetKey,
  validateRequest,
} from "../../engine/contracts/report/target.js";
import { type DocumentScope, presetFor, resolveSections } from "../../engine/contracts/report/presets.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import {
  accountExecutablePlan,
  projectLevelFootprint,
  verifyDedup,
} from "../../engine/report/combination.js";
import { executeAuthoredTasks } from "../../engine/report/execute.js";
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

/** The section ids the preset for a target resolves to, all included by default. */
function expectedSectionIds(scope: Scope, audience: Audience): readonly string[] {
  const docScope: DocumentScope = scope.kind === "project" ? "project" : "module";
  const { required, optional } = resolveSections(presetFor(docScope, audience));
  return [...required, ...optional].map((s) => s.id).sort();
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

    it(`${name}: each document's sections and blocks match its preset exactly`, () => {
      const e = compile(request);
      // Every produced document's sections are exactly its preset's — a per-target
      // structural check, not a loose "> 0". A regression that drops or adds a
      // section, or mislabels a block kind, fails here.
      let deterministic = 0;
      let authored = 0;
      for (const target of request) {
        const doc = e.plan.documents.find((d) => d.documentId === targetKey(target))!;
        expect([...doc.sections.map((s) => s.sectionId)].sort()).toEqual(expectedSectionIds(target.scope, target.audience));
        for (const block of doc.sections.flatMap((s) => s.blocks)) {
          // a block is authored iff it carries a task, deterministic otherwise — no third kind
          if (block.task !== undefined) authored += 1;
          else deterministic += 1;
        }
      }
      const a = accountExecutablePlan(e);
      expect(a.deterministicBlockCount).toBe(deterministic);
      expect(a.authoredTaskCount).toBe(authored);
      expect(a.deterministicBlockCount + a.authoredTaskCount).toBe(deterministic + authored); // every block classified
    });

    it(`${name}: the whole request is bound to one analysis — no provider fan-out`, () => {
      const e = compile(request);
      // One snapshot, one run identity for every document and every authored task:
      // the report reads a frozen analysis snapshot and runs no provider itself, so
      // a multi-document request cannot re-read source or re-run a provider. Report-
      // time source reads / provider executions / fact queries are zero by
      // construction; the accounting below covers slice/render/host-task counts.
      const snapshotKeys = new Set(authoredTasks(e.plan).map((t) => t.identity.snapshotKey));
      snapshotKeys.add(e.plan.runIdentity.snapshotKey);
      expect(snapshotKeys.size).toBe(1);
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
  const scope: Scope = { kind: "project" };
  const sharedProblem: ProblemRecord = {
    problemId: problemId(scope, "state-leak", ["diag:1", "diag:2"]),
    scope,
    category: "state-leak",
    resolution: "observed",
    confidence: "high",
    evidenceIds: ["diag:1", "diag:2"],
    citations: ["diag:1", "diag:2"],
    impactBoundary: "the leave flow",
  };

  it("the same problem carries one fact id and citation set into both documents' shared ledger", () => {
    const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;
    // the same problem is projected once for each audience document — it must dedup
    // to one ledger record with identical evidence ids and citations, not two.
    const e = compileExecutablePlan({
      request: both.request,
      snapshot: SNAPSHOT,
      params: PARAMS,
      analysisRunId: "run-1",
      problems: [sharedProblem, sharedProblem],
    });
    expect(e.plan.documents.length).toBe(2);
    expect(e.plan.problemLedger).toHaveLength(1); // deduped, not re-minted per audience
    const record = e.plan.problemLedger[0]!;
    expect(record.problemId).toBe(sharedProblem.problemId);
    expect(record.evidenceIds).toEqual(["diag:1", "diag:2"]); // one fact-id set
    expect(record.citations).toEqual(["diag:1", "diag:2"]); // one citation set
    // the ledger lives once on the plan, referenced by every document — no per-document copy to diverge
    expect(e.plan.documents.every((d) => !Object.prototype.hasOwnProperty.call(d, "problemLedger"))).toBe(true);
  });

  it("fails closed when two sources describe one problem id divergently", () => {
    const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;
    const divergent: ProblemRecord = { ...sharedProblem, confidence: "low" }; // same id, different field
    expect(() =>
      compileExecutablePlan({
        request: both.request,
        snapshot: SNAPSHOT,
        params: PARAMS,
        analysisRunId: "run-1",
        problems: [sharedProblem, divergent],
      }),
    ).toThrow();
  });

  it("the shared known-issues.impact block carries one identity — blockId, schema and slice — in both documents", () => {
    const both = LEGAL_COMBINATION_EXAMPLES.find((c) => c.name === "project/both")!;
    const e = compile(both.request);
    const shared = e.plan.documents.map((d) => {
      const section = d.sections.find((s) => s.sectionId === "known-issues")!;
      const block = section.blocks.find((b) => b.blockId === "known-issues.impact")!;
      return { blockId: block.blockId, schema: block.outputSchemaId, sliceKey: block.factSlice.sliceKey, shared: block.carriesSharedClaim };
    });
    // identical fact identity (block id, output schema, slice key) across both audiences — one claim, not two
    expect(new Set(shared.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(shared[0]!.shared).toBe(true); // it is a shared-claim block
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

  it("a bundle's members share no fate: failing one leaves its siblings validated", () => {
    const e = compile(both.request);
    // pick a bundle that groups more than one task, and fail exactly one member
    const multi = e.bundlePlan.bundles.find((b) => b.taskIds.length > 1);
    expect(multi, "expected a bundle grouping more than one authored task").toBeDefined();
    const [failed, ...siblings] = multi!.taskIds;
    const run = executeAuthoredTasks(e.plan, fakeHost({ alwaysReject: new Set([failed!]) }));

    const validated = new Set(Object.keys(run.assembly.artifactByTask));
    expect(validated.has(failed!)).toBe(false); // the failed member has no validated artifact
    for (const sib of siblings) expect(validated.has(sib)).toBe(true); // its siblings still passed
    expect(run.assembly.missingRequired).toEqual([failed!]); // only the one is missing
  });

  it("final artifact order is fixed by the plan, not by task-completion timing", () => {
    const e = compile(both.request);
    const order = authoredTasks(e.plan).map((t) => t.taskId);
    // two runs whose adoptions land on different attempts — a flaky task "completes"
    // later — must still yield artifacts in the same plan order.
    const clean = executeAuthoredTasks(e.plan, fakeHost());
    const late = executeAuthoredTasks(e.plan, fakeHost({ flakyUntil: { [order[order.length - 1]!]: 1 } }));
    expect(clean.artifacts.map((a) => a.taskId)).toEqual(order);
    expect(late.artifacts.map((a) => a.taskId)).toEqual(order); // completion timing changed, order did not
  });
});
