import { describe, expect, it } from "vitest";

import { moduleTarget, type ReportTarget, type Scope } from "../../engine/contracts/report/target.js";
import type { SectionDefinition } from "../../engine/contracts/report/catalog.js";
import type { AuthoredBlockTask, GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import type { KindCoverageInput, SectionApplicabilityDecision } from "../../engine/report/applicability.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { executeAuthoredTasks } from "../../engine/report/execute.js";
import { produceDualReport } from "../../engine/report/dual-report.js";
import { type DecisionIndex, deterministicContent } from "../../engine/report/deterministic-content.js";
import { deterministicHost } from "../../engine/report/deterministic-host.js";
import { coverageInputForKind, createSliceReaders, resolveKindCoverage } from "../../engine/report/slice-resolve.js";
import { SNAPSHOT_ID, insertBehaviorFact, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";

const IN_MODULE = ["handlers/leave/service.go"];

/** Seed a KB with error-handling + data-access + condition facts in the leave module. */
function seedGroundedKb() {
  const store = seedStore();
  for (const kind of ["error-handling", "data-access", "condition", "decision", "validation-rule", "transition"]) {
    insertBehaviorFact(store, { factId: `behavioral|${kind}|r1|handlers/leave/service.go:1|${kind}`, kind, relPath: "handlers/leave/service.go", startLine: 1 });
  }
  return store;
}

function decisionIndexOf(applicability: readonly { documentId: string; decision: SectionApplicabilityDecision }[]): DecisionIndex {
  const index = new Map<string, Map<string, SectionApplicabilityDecision>>();
  for (const { documentId, decision } of applicability) {
    const inner = index.get(documentId) ?? new Map<string, SectionApplicabilityDecision>();
    inner.set(decision.sectionId, decision);
    index.set(documentId, inner);
  }
  return index;
}

const snapshot: AnalysisSnapshotIdentity = { sourceIdentity: "s", codeGraphIdentity: "s", providerIdentity: "s", schemaVersion: "1.0.0", configIdentity: "s" };
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-test", language: "en" };

function buildPipeline(store: ReturnType<typeof seedStore>, request: readonly ReportTarget[]) {
  const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
  const coverage = (target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] =>
    section.inputFactKinds.map((kind) => ({ kind, coverage: coverageInputForKind(resolveKindCoverage(readers, target.scope, kind)) }));
  const executable = compileExecutablePlan({ request, snapshot, params, analysisRunId: "run-1", coverage });
  const decisions = decisionIndexOf(executable.applicability);
  const host = deterministicHost({ readers, decisions });
  const run = executeAuthoredTasks(executable.plan, host);
  const content = deterministicContent({ readers, decisions });
  const dual = produceDualReport(executable.plan, executable.slices, run.artifacts, content);
  const validatedTaskIds = new Set(run.artifacts.filter((a) => a.validated).map((a) => a.taskId));
  return { executable, run, dual, validatedTaskIds };
}

describe("deterministicHost — validates a grounded or legitimately-unknown authored task, gaps the rest", () => {
  it("validates the module's authored tasks and produces a real validatedTaskIds set", () => {
    const { run, validatedTaskIds } = buildPipeline(seedGroundedKb(), [moduleTarget("leave", "developer")]);
    expect(run.counters.hostAgentTasks).toBeGreaterThan(0);
    expect(validatedTaskIds.size).toBeGreaterThan(0);
    // Not the vacuous all-pass: a task is validated with a stated basis.
    expect(run.ledgers.every((l) => l.attempts.length >= 1)).toBe(true);
  });

  it("leaves an authored block a marked gap when its section has no facts and no not-applicable/unknown decision", () => {
    // A task in a section that resolves nothing, with an `included` (not NA/unknown) decision.
    const readers = createSliceReaders(seedStore(), SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const decision: SectionApplicabilityDecision = { sectionId: "module-notifications-data", applicability: "included", state: "not-found", reason: "found none", evidence: [] };
    const decisions: DecisionIndex = new Map([["module:leave|product", new Map([["module-notifications-data", decision]])]]);
    const host = deterministicHost({ readers, decisions });
    const task = {
      taskId: "t1",
      documentId: "module:leave|product",
      sectionId: "module-notifications-data",
      blockId: "module-notifications-data.notes",
      outputSchemaId: "module-effects-notes.v1",
      prompt: { promptId: "p", promptVersion: "1" },
      citationRule: "required",
      validatorId: "module-effects-notes.v1",
      factSlice: { scope: { kind: "module", moduleId: "leave" } as Scope, factKinds: ["outbound-call"], sliceKey: "k" },
      identity: { executorKind: "host-agent", modelId: "m", promptHash: "h", pipelineVersion: "1", presetVersion: "1", generatorVersion: "1", policyId: "standard-v1", policyVersion: "1", language: "en", params: {}, snapshotKey: "s" },
    } satisfies AuthoredBlockTask;
    const receipt = host.execute(task);
    expect(receipt.outcome).toBe("rejected");
    expect(receipt.validationOk).toBe(false);
    expect(receipt.detail).toContain("marked gap");
  });
});

describe("determinism — two full runs over one frozen KB give identical digests", () => {
  it("produces byte-identical execution and rendered digests across two runs", () => {
    const request = [moduleTarget("leave", "product"), moduleTarget("leave", "developer")];
    const first = buildPipeline(seedGroundedKb(), request);
    const second = buildPipeline(seedGroundedKb(), request);
    expect(first.executable.plan.planDigest).toEqual(second.executable.plan.planDigest);
    expect(first.executable.auditDigest).toEqual(second.executable.auditDigest);
    expect(first.run.executionDigest).toEqual(second.run.executionDigest);
    expect(first.dual.rendered.manifest.structureDigest).toEqual(second.dual.rendered.manifest.structureDigest);
    // A deterministic run also renders byte-stable prose, so the informational fold matches too.
    expect(first.dual.rendered.manifest.renderedBytesDigest).toEqual(second.dual.rendered.manifest.renderedBytesDigest);
  });
});
