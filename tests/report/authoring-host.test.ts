import { describe, expect, it } from "vitest";

import { moduleTarget, type ReportTarget, type Scope } from "../../engine/contracts/report/target.js";
import type { SectionDefinition } from "../../engine/contracts/report/catalog.js";
import { type AuthoredBlockTask, type GenerationParams, authoredTasks } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import type { KindCoverageInput, SectionApplicabilityDecision } from "../../engine/report/applicability.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { executeAuthoredTasks } from "../../engine/report/execute.js";
import { produceDualReport } from "../../engine/report/dual-report.js";
import { type DecisionIndex, deterministicContent } from "../../engine/report/deterministic-content.js";
import { type AuthoredPromptContract } from "../../engine/report/author-prompt.js";
import { type ProseStore, authoringHost } from "../../engine/report/authoring-host.js";
import { authoredContent } from "../../engine/report/authored-content.js";
import { coverageInputForKind, createSliceReaders, resolveKindCoverage } from "../../engine/report/slice-resolve.js";
import { PM_AUTHORED_BLOCKS } from "../../engine/report/presets/pm.js";
import { DEV_AUTHORED_BLOCKS } from "../../engine/report/presets/dev.js";
import { SNAPSHOT_ID, insertBehaviorFact, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";
import { type FakeAuthorConfig, fakeAuthor } from "./helpers/fake-author.js";

const IN_MODULE = ["handlers/leave/service.go"];
const snapshot: AnalysisSnapshotIdentity = { sourceIdentity: "s", codeGraphIdentity: "s", providerIdentity: "s", schemaVersion: "1.0.0", configIdentity: "s" };
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-test", language: "en" };

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

function contractsByBlockId(): Map<string, AuthoredPromptContract> {
  const map = new Map<string, AuthoredPromptContract>();
  for (const c of [...PM_AUTHORED_BLOCKS, ...DEV_AUTHORED_BLOCKS]) map.set(c.blockId, c);
  return map;
}

function buildPipeline(store: ReturnType<typeof seedStore>, request: readonly ReportTarget[], config: FakeAuthorConfig = {}) {
  const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
  const coverage = (target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] =>
    section.inputFactKinds.map((kind) => ({ kind, coverage: coverageInputForKind(resolveKindCoverage(readers, target.scope, kind)) }));
  const executable = compileExecutablePlan({ request, snapshot, params, analysisRunId: "run-1", coverage });
  const decisions = decisionIndexOf(executable.applicability);
  const proseStore: ProseStore = new Map();
  const recording = fakeAuthor(config);
  const host = authoringHost({ readers, decisions, contractsByBlockId: contractsByBlockId(), author: recording.author, proseStore });
  const run = executeAuthoredTasks(executable.plan, host);
  const validatedTaskIds = new Set(run.artifacts.filter((a) => a.validated).map((a) => a.taskId));
  const content = authoredContent(proseStore, deterministicContent({ readers, decisions }));
  const grounded = new Map<string, readonly string[]>([...proseStore].map(([taskId, a]) => [taskId, a.groundedFactIds]));
  const dual = produceDualReport(executable.plan, executable.slices, run.artifacts, content, { groundedFactIdsByTask: grounded });
  return { executable, run, dual, validatedTaskIds, proseStore, recording };
}

describe("authoringHost — accepts grounded prose, writes it to the store, cites it", () => {
  it("accept-on-grounded: authored blocks validate and render prose with a citations footnote", () => {
    const p = buildPipeline(seedGroundedKb(), [moduleTarget("leave", "developer")]);
    expect(p.proseStore.size).toBeGreaterThan(0);
    expect(p.validatedTaskIds.size).toBeGreaterThan(0);
    const md = p.dual.rendered.documents.map((d) => d.markdown).join("\n");
    expect(md).toContain("_Citations:_"); // authored prose renders its expanded citations
    // Every accepted authored artifact grounds ≥1 in-slice fact.
    for (const artifact of p.proseStore.values()) expect(artifact.groundedFactIds.length).toBeGreaterThan(0);
  });
});

describe("authoringHost — surfaces the best-effort uncited-sentence signal in the receipt (P1-d)", () => {
  it("accepts grounded prose and reports its uncited-factual-sentence count in the detail", () => {
    const baseline = buildPipeline(seedGroundedKb(), [moduleTarget("leave", "developer")]);
    const taskId = [...baseline.proseStore.keys()][0]!;
    // Grounded (cites [1]) but with a second, marker-free factual sentence.
    const prose = "Fact one is recorded [1]. The file service.go is central.";
    const p = buildPipeline(seedGroundedKb(), [moduleTarget("leave", "developer")], { proseByTask: { [taskId]: prose } });
    expect(p.validatedTaskIds.has(taskId)).toBe(true);
    const adopted = p.run.ledgers.find((l) => l.taskId === taskId)!.attempts.at(-1)!;
    expect(adopted.outcome).toBe("accepted");
    expect(adopted.detail).toContain("uncited factual sentence");
    expect(p.proseStore.get(taskId)!.prose).toBe(prose);
  });
});

describe("authoringHost — rejects ungrounded prose, feeding the retry/gap loop", () => {
  it("reject-on-ungrounded→gap: a foreign-citing block is retried, never validated, and left a marked gap", () => {
    // First find an authored task whose own slice actually grounds (so it is authored).
    const baseline = buildPipeline(seedGroundedKb(), [moduleTarget("leave", "developer")]);
    const groundedTaskId = [...baseline.proseStore.keys()][0]!;

    const p = buildPipeline(seedGroundedKb(), [moduleTarget("leave", "developer")], { ungrounded: new Set([groundedTaskId]) });
    expect(p.validatedTaskIds.has(groundedTaskId)).toBe(false);
    expect(p.proseStore.has(groundedTaskId)).toBe(false);
    // Retried to the policy budget (3 attempts), each rejected with the ungrounded detail.
    expect(p.recording.callCount(groundedTaskId)).toBe(3);
    const ledger = p.run.ledgers.find((l) => l.taskId === groundedTaskId)!;
    expect(ledger.attempts.every((a) => a.outcome === "rejected")).toBe(true);
    expect(ledger.attempts.at(-1)!.detail).toContain("ungrounded");
    // The block renders as a marked gap in the developer document.
    const md = p.dual.rendered.documents.map((d) => d.markdown).join("\n");
    expect(md).toContain("[gap:");
  });
});

describe("authoringHost — structured-disclosure passthrough (no prose authored)", () => {
  it("accepts an empty-slice block with a not-applicable/unknown decision, without calling the author", () => {
    const readers = createSliceReaders(seedStore(), SNAPSHOT_ID, membershipOf("leave", IN_MODULE)); // no facts
    const decision: SectionApplicabilityDecision = { sectionId: "module-responsibility", applicability: "unknown", state: "unknown", reason: "insufficient evidence", evidence: [] };
    const decisions: DecisionIndex = new Map([["module:leave|product", new Map([["module-responsibility", decision]])]]);
    const proseStore: ProseStore = new Map();
    const recording = fakeAuthor();
    const host = authoringHost({ readers, decisions, contractsByBlockId: contractsByBlockId(), author: recording.author, proseStore });
    const task = {
      taskId: "t-disclosure",
      documentId: "module:leave|product",
      sectionId: "module-responsibility",
      blockId: "module-responsibility.summary",
      outputSchemaId: "module-responsibility.v1",
      prompt: { promptId: "p", promptVersion: "1" },
      citationRule: "required",
      validatorId: "module-responsibility.v1",
      factSlice: { scope: { kind: "module", moduleId: "leave" } as Scope, factKinds: ["module"], sliceKey: "k" },
      identity: { executorKind: "host-agent", modelId: "m", promptHash: "h", pipelineVersion: "1", presetVersion: "1", generatorVersion: "1", policyId: "standard-v1", policyVersion: "1", language: "en", params: {}, snapshotKey: "s" },
    } satisfies AuthoredBlockTask;

    const receipt = host.execute(task);
    expect(receipt.outcome).toBe("accepted");
    expect(receipt.validationOk).toBe(true);
    expect(receipt.detail).toContain("structured unknown disclosure");
    expect(recording.calls.length).toBe(0); // the author is never called for a disclosure
    expect(proseStore.size).toBe(0); // and no prose is stored
  });

  it("rejects an empty-slice block with no not-applicable/unknown decision — a marked gap", () => {
    const readers = createSliceReaders(seedStore(), SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const decision: SectionApplicabilityDecision = { sectionId: "module-responsibility", applicability: "included", state: "not-found", reason: "found none", evidence: [] };
    const decisions: DecisionIndex = new Map([["module:leave|product", new Map([["module-responsibility", decision]])]]);
    const proseStore: ProseStore = new Map();
    const recording = fakeAuthor();
    const host = authoringHost({ readers, decisions, contractsByBlockId: contractsByBlockId(), author: recording.author, proseStore });
    const task = {
      taskId: "t-gap",
      documentId: "module:leave|product",
      sectionId: "module-responsibility",
      blockId: "module-responsibility.summary",
      outputSchemaId: "module-responsibility.v1",
      prompt: { promptId: "p", promptVersion: "1" },
      citationRule: "required",
      validatorId: "module-responsibility.v1",
      factSlice: { scope: { kind: "module", moduleId: "leave" } as Scope, factKinds: ["module"], sliceKey: "k" },
      identity: { executorKind: "host-agent", modelId: "m", promptHash: "h", pipelineVersion: "1", presetVersion: "1", generatorVersion: "1", policyId: "standard-v1", policyVersion: "1", language: "en", params: {}, snapshotKey: "s" },
    } satisfies AuthoredBlockTask;

    const receipt = host.execute(task);
    expect(receipt.outcome).toBe("rejected");
    expect(receipt.detail).toContain("marked gap");
    expect(recording.calls.length).toBe(0);
  });
});

describe("authoredContent — delegates unauthored blocks to the deterministic fallback", () => {
  it("renders the deterministic digest for a task not in the prose store", () => {
    const p = buildPipeline(seedGroundedKb(), [moduleTarget("leave", "developer")]);
    // Every authored task ledger exists; the run has both authored (in store) and
    // deterministic blocks. The rendered developer doc still contains deterministic
    // fact digests for the deterministic blocks (fallback path).
    const md = p.dual.rendered.documents.map((d) => d.markdown).join("\n");
    expect(md).toContain("deterministic fact digest");
    expect(authoredTasks(p.executable.plan).length).toBeGreaterThan(0);
  });
});
