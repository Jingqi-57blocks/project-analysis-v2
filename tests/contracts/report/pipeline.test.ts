import { describe, expect, it } from "vitest";

import {
  type AuthoredBlockTask,
  type CompileOptions,
  type GenerationParams,
  type HostAgent,
  type ProblemRecord,
  RegistryError,
  STANDARD_PIPELINE,
  adoptedAttempt,
  assertSliceInBounds,
  authoredTasks,
  buildProblemLedger,
  compileReportPlan,
  emptyLedger,
  problemId,
  recordAttempt,
} from "../../../engine/contracts/report/pipeline.js";
import type { SectionDefinition } from "../../../engine/contracts/report/catalog.js";
import type { DocumentPreset } from "../../../engine/contracts/report/presets.js";
import { deterministicBlock, authoredBlock } from "../../../engine/contracts/report/blocks.js";
import {
  moduleTarget,
  projectTarget,
  type ReportRequest,
} from "../../../engine/contracts/report/target.js";
import type { AnalysisSnapshotIdentity } from "../../../engine/contracts/report/snapshot.js";
import { blockFromLegacySection } from "../../../engine/render/blocks-compat.js";
import type { CodeSection, LlmSection } from "../../../engine/render/template.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "src-1",
  codeGraphIdentity: "graph-1",
  providerIdentity: "providers-1",
  schemaVersion: "1.0.0",
  configIdentity: "config-1",
};

const PARAMS: GenerationParams = {
  executorKind: "host-agent",
  modelId: "claude-opus-4-8",
  language: "en",
};

function compile(request: ReportRequest, extra: Partial<CompileOptions> = {}) {
  return compileReportPlan({ request, snapshot: SNAPSHOT, params: PARAMS, ...extra });
}

describe("compileReportPlan — determinism", () => {
  it("is byte-stable for the same request, snapshot and versions", () => {
    const request = [projectTarget("product"), projectTarget("developer")];
    const a = compile(request);
    const b = compile(request);
    expect(a.planDigest).toBe(b.planDigest);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not depend on the order targets were requested", () => {
    const ordered = compile([projectTarget("product"), projectTarget("developer")]);
    const reversed = compile([projectTarget("developer"), projectTarget("product")]);
    expect(reversed.planDigest).toBe(ordered.planDigest);
  });

  it("gives every authored task a citation rule and a bounded slice within its block", () => {
    const plan = compile([projectTarget("product")]);
    const tasks = authoredTasks(plan);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.citationRule).toBe("required");
      expect(task.validatorId).toBe(task.outputSchemaId);
      expect(task.factSlice.factKinds.length).toBeGreaterThan(0);
    }
  });
});

describe("compileReportPlan — identity moves with each dimension", () => {
  const base = () => compile([projectTarget("product")]);

  it("changes when the model changes", () => {
    const other = compile([projectTarget("product")], {
      params: { ...PARAMS, modelId: "claude-sonnet-5" },
    });
    expect(other.planDigest).not.toBe(base().planDigest);
    expect(other.runIdentity.modelId).toBe("claude-sonnet-5");
  });

  it("changes when the executor changes", () => {
    const other = compile([projectTarget("product")], {
      params: { ...PARAMS, executorKind: "codex-cli" },
    });
    expect(other.planDigest).not.toBe(base().planDigest);
  });

  it("changes when the prompt binding changes", () => {
    const other = compile([projectTarget("product")], {
      promptResolver: (block) => ({ promptId: block.outputSchemaId, promptVersion: "9.9.9" }),
    });
    expect(other.planDigest).not.toBe(base().planDigest);
  });

  it("changes when the preset or generator version changes", () => {
    const preset = compile([projectTarget("product")], { versions: { preset: "2.0.0" } });
    const generator = compile([projectTarget("product")], { versions: { generator: "2.0.0" } });
    expect(preset.planDigest).not.toBe(base().planDigest);
    expect(generator.planDigest).not.toBe(base().planDigest);
  });

  it("changes when language or generation params change", () => {
    const language = compile([projectTarget("product")], { params: { ...PARAMS, language: "zh" } });
    const params = compile([projectTarget("product")], {
      params: { ...PARAMS, params: { temperature: 0.2 } },
    });
    expect(language.planDigest).not.toBe(base().planDigest);
    expect(params.planDigest).not.toBe(base().planDigest);
  });

  it("keeps every authored task id unique within a plan", () => {
    const plan = compile([
      projectTarget("product"),
      projectTarget("developer"),
      moduleTarget("leave", "product"),
    ]);
    const ids = authoredTasks(plan).map((t) => t.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("compileReportPlan — fail closed", () => {
  it("rejects an illegal request", () => {
    expect(() => compile([])).toThrow(RegistryError);
    expect(() => compile([projectTarget("product"), projectTarget("product")])).toThrow(RegistryError);
  });

  it("rejects a preset that references an unknown section", () => {
    const badPreset: DocumentPreset = {
      id: "project-product",
      scope: "project",
      audience: "product",
      requiredSectionIds: ["no-such-section"],
      optionalSectionIds: [],
    };
    expect(() => compile([projectTarget("product")], { presets: [badPreset] })).toThrow(RegistryError);
  });

  it("rejects a preset not registered with the pipeline", () => {
    const pipeline = { ...STANDARD_PIPELINE, documentPresetIds: ["module-developer-detail"] };
    expect(() => compile([projectTarget("product")], { pipeline })).toThrow(/not registered/);
  });

  it("rejects a cyclic section dependency", () => {
    expect(() =>
      compile([projectTarget("product")], {
        dependencies: { identity: ["coverage"], coverage: ["identity"] },
      }),
    ).toThrow(/cyclic/);
  });

  it("rejects a dependency on an unknown section", () => {
    expect(() =>
      compile([projectTarget("product")], { dependencies: { identity: ["ghost-section"] } }),
    ).toThrow(/unknown section/);
  });

  it("rejects a section whose block reads a fact kind outside the section", () => {
    const rogue: SectionDefinition = {
      id: "rogue",
      title: "Rogue",
      requirement: "required",
      scope: "shared",
      audience: "shared",
      blocks: [deterministicBlock("rogue.table", ["route"], "rogue.v1")],
      inputFactKinds: ["module"], // block reads `route`, which is not here
      successCondition: "never",
    };
    const preset: DocumentPreset = {
      id: "project-product",
      scope: "project",
      audience: "product",
      requiredSectionIds: ["rogue"],
      optionalSectionIds: [],
    };
    expect(() =>
      compile([projectTarget("product")], { presets: [preset], catalog: [rogue] }),
    ).toThrow(/outside section/);
  });

  it("rejects an out-of-bound fact slice directly", () => {
    const block = authoredBlock("b", ["condition"], "b.v1");
    expect(() =>
      assertSliceInBounds(block, { scope: { kind: "project" }, factKinds: ["route"], sliceKey: "k" }),
    ).toThrow(RegistryError);
    // the block's own declared kinds are always in-bound
    expect(() =>
      assertSliceInBounds(block, { scope: { kind: "project" }, factKinds: ["condition"], sliceKey: "k" }),
    ).not.toThrow();
  });
});

describe("problem ledger", () => {
  const evidence = ["diag:c", "diag:a", "diag:b"];

  it("is deterministic and order-independent over evidence", () => {
    const scope = { kind: "project" as const };
    const id1 = problemId(scope, "state-leak", evidence);
    const id2 = problemId(scope, "state-leak", ["diag:a", "diag:b", "diag:c"]);
    expect(id1).toBe(id2);
  });

  it("distinguishes scope and category", () => {
    const asProject = problemId({ kind: "project" }, "state-leak", evidence);
    const asModule = problemId({ kind: "module", moduleId: "leave" }, "state-leak", evidence);
    const otherCategory = problemId({ kind: "project" }, "auth-gap", evidence);
    expect(asProject).not.toBe(asModule);
    expect(asProject).not.toBe(otherCategory);
  });

  it("dedups records that share an id", () => {
    const record: ProblemRecord = {
      problemId: problemId({ kind: "project" }, "state-leak", evidence),
      scope: { kind: "project" },
      category: "state-leak",
      resolution: "observed",
      confidence: "high",
      evidenceIds: evidence,
      citations: evidence,
      impactBoundary: "the leave module",
    };
    expect(buildProblemLedger([record, record]).length).toBe(1);
  });

  it("is one shared record identity across product-only, developer-only and both", () => {
    const record: ProblemRecord = {
      problemId: problemId({ kind: "project" }, "state-leak", evidence),
      scope: { kind: "project" },
      category: "state-leak",
      resolution: "observed",
      confidence: "high",
      evidenceIds: evidence,
      citations: evidence,
      impactBoundary: "the leave module",
    };
    const problems = [record];
    const productOnly = compile([projectTarget("product")], { problems });
    const developerOnly = compile([projectTarget("developer")], { problems });
    const both = compile([projectTarget("product"), projectTarget("developer")], { problems });

    const ids = (plan: ReturnType<typeof compile>) => plan.problemLedger.map((p) => p.problemId);
    expect(ids(productOnly)).toEqual([record.problemId]);
    expect(ids(developerOnly)).toEqual([record.problemId]);
    expect(ids(both)).toEqual([record.problemId]);

    // No cross-audience execution dependency: each single-audience plan holds
    // only its own document, and neither needs the other to have been generated.
    expect(productOnly.documents.map((d) => d.audience)).toEqual(["product"]);
    expect(developerOnly.documents.map((d) => d.audience)).toEqual(["developer"]);
  });
});

describe("multi-document compilation", () => {
  it("compiles one plan for every requested target and nothing for the rest", () => {
    const plan = compile([projectTarget("product"), moduleTarget("leave", "developer")]);
    const docs = plan.documents.map((d) => d.documentId).sort();
    expect(docs).toEqual(["module:leave|developer", "project|product"].sort());
    // one execution bundle per document, each naming only its own tasks
    expect(plan.bundles.map((b) => b.documentId).sort()).toEqual(docs);
  });

  it("produces zero project documents for a module-only request, sharing one snapshot", () => {
    const plan = compile([moduleTarget("leave", "product"), moduleTarget("leave", "developer")]);
    expect(plan.documents.every((d) => d.scope.kind === "module")).toBe(true);
    expect(plan.documents.some((d) => d.scope.kind === "project")).toBe(false);
    expect(plan.snapshot).toEqual(SNAPSHOT);
  });

  it("gives blocks reading the same slice one shared slice key across documents", () => {
    const plan = compile([projectTarget("product"), projectTarget("developer")]);
    // the shared identity section appears in both documents with the same slice key
    const keys = plan.documents.map((doc) => {
      const identity = doc.sections.find((s) => s.sectionId === "identity");
      return identity?.blocks[0]?.factSlice.sliceKey;
    });
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("execution boundary — attempt receipts and a fake Host Agent", () => {
  // A fake host: it accepts on the second attempt, so the ledger must keep the
  // first (rejected) attempt and still locate the adopted one.
  function fakeHost(acceptOnAttempt: number): HostAgent {
    const seen = new Map<string, number>();
    return {
      execute(task: AuthoredBlockTask) {
        const n = (seen.get(task.taskId) ?? 0) + 1;
        seen.set(task.taskId, n);
        const accepted = n >= acceptOnAttempt;
        return {
          executorKind: task.identity.executorKind,
          modelId: task.identity.modelId,
          outcome: accepted ? ("accepted" as const) : ("rejected" as const),
          artifactRef: accepted ? `artifact/${task.taskId}` : null,
          validationOk: accepted,
          detail: accepted ? "cited and valid" : "missing citation",
        };
      },
    };
  }

  it("keeps every attempt and adopts the last accepted one", () => {
    const plan = compile([projectTarget("product")]);
    const host = fakeHost(2);
    const task = authoredTasks(plan)[0]!;

    let ledger = emptyLedger(task.taskId);
    ledger = recordAttempt(ledger, { taskId: task.taskId, ...host.execute(task) });
    ledger = recordAttempt(ledger, { taskId: task.taskId, ...host.execute(task) });

    expect(ledger.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(ledger.attempts[0]!.outcome).toBe("rejected");
    const adopted = adoptedAttempt(ledger);
    expect(adopted?.attempt).toBe(2);
    expect(adopted?.artifactRef).toBe(`artifact/${task.taskId}`);
  });

  it("adopts nothing when no attempt is accepted", () => {
    const plan = compile([projectTarget("product")]);
    const host = fakeHost(99);
    const task = authoredTasks(plan)[0]!;
    let ledger = emptyLedger(task.taskId);
    ledger = recordAttempt(ledger, { taskId: task.taskId, ...host.execute(task) });
    expect(adoptedAttempt(ledger)).toBeNull();
  });

  it("refuses to record an attempt for a different task", () => {
    const ledger = emptyLedger("task-a");
    expect(() =>
      recordAttempt(ledger, {
        taskId: "task-b",
        executorKind: "host-agent",
        modelId: "m",
        outcome: "accepted",
        artifactRef: "x",
        validationOk: true,
        detail: "",
      }),
    ).toThrow();
  });
});

describe("legacy compatibility bridge", () => {
  it("maps a code section to one deterministic block, keeping its id", () => {
    const section: CodeSection = { kind: "code", id: "overview", heading: "Overview", requires: [], fragment: "f" };
    const block = blockFromLegacySection(section);
    expect(block.id).toBe("overview");
    expect(block.kind).toBe("deterministic");
  });

  it("maps an llm section to one authored-required block, keeping its id", () => {
    const section: LlmSection = { kind: "llm", id: "summary", heading: "Summary", requires: [], prompt: "p.md" };
    const block = blockFromLegacySection(section);
    expect(block.id).toBe("summary");
    expect(block.kind).toBe("authored-required");
  });
});
