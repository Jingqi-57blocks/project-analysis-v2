import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SectionDefinition } from "../../engine/contracts/report/catalog.js";
import type { GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { moduleTarget, type ReportTarget } from "../../engine/contracts/report/target.js";
import type { KindCoverageInput, SectionApplicabilityDecision } from "../../engine/report/applicability.js";
import { boundedFactsFor, prepareBatchAuthor } from "../../engine/report/batch-author.js";
import type { AuthoringRequest } from "../../engine/report/author-prompt.js";
import type { DecisionIndex } from "../../engine/report/deterministic-content.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { PM_AUTHORED_BLOCKS } from "../../engine/report/presets/pm.js";
import { coverageInputForKind, createSliceReaders, resolveKindCoverage, type CitedFact } from "../../engine/report/slice-resolve.js";
import { SNAPSHOT_ID, insertBehaviorFact, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function decisionsOf(applicability: readonly { documentId: string; decision: SectionApplicabilityDecision }[]): DecisionIndex {
  const result = new Map<string, Map<string, SectionApplicabilityDecision>>();
  for (const { documentId, decision } of applicability) {
    const inner = result.get(documentId) ?? new Map<string, SectionApplicabilityDecision>();
    inner.set(decision.sectionId, decision);
    result.set(documentId, inner);
  }
  return result;
}

describe("prepareBatchAuthor", () => {
  it("authors each section independently and reuses every validated task on the next run", async () => {
    const store = seedStore();
    const relPath = "handlers/leave/service.go";
    for (const kind of ["condition", "business-rule", "data-access", "outbound-call", "notification-call"]) {
      insertBehaviorFact(store, {
        factId: `behavioral|${kind}|r1|${relPath}:10|${kind}`,
        kind,
        relPath,
        startLine: 10,
        payload: kind === "condition" ? { subject: "hours", text: "hours > 8", guarded: "rejects" } : { target: "service", operation: "read" },
      });
    }
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", [relPath]));
    const request: readonly ReportTarget[] = [moduleTarget("leave", "product")];
    const snapshot: AnalysisSnapshotIdentity = { sourceIdentity: "s", codeGraphIdentity: "s", providerIdentity: "s", schemaVersion: "1", configIdentity: "s" };
    const params: GenerationParams = { executorKind: "test", modelId: "fake", language: "zh-CN" };
    const coverage = (target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] => section.inputFactKinds.map((kind) => ({
      kind,
      coverage: coverageInputForKind(resolveKindCoverage(readers, target.scope, kind)),
    }));
    const executable = compileExecutablePlan({ request, snapshot, params, analysisRunId: "run", coverage });
    const cacheDir = mkdtempSync(join(tmpdir(), "pa-batch-author-"));
    temporary.push(cacheDir);
    let calls = 0;
    const runner = async (agentRequest: { prompt: string }) => {
      calls += 1;
      const taskJson = agentRequest.prompt.split("Tasks:\n").at(-1)!.split("\n\nShared bounded fact table:")[0]!;
      const tasks = JSON.parse(taskJson) as { taskId: string; blockId: string; structuredFlowRequired: boolean; structuredLifecycleRequired: boolean; structuredIssueReview: boolean; factIds: string[] }[];
      expect(tasks).toHaveLength(1);
      return {
        tasks: tasks.map((task) => {
          const ids = task.factIds;
          const first = ids[0]!;
          return {
            taskId: task.taskId,
            claims: [{ text: "该部分由当前事实支持。", factIds: [first] }],
            flowGroups: task.structuredFlowRequired ? [{
              title: "主要流程",
              summary: "按已知条件处理",
              factIds: [first],
              steps: [{ label: "处理请求", detail: "读取当前事实", factIds: [first] }],
              branches: [{ afterStep: 1, condition: "已知条件", outcome: "继续处理", kind: "conditional" as const, factIds: ids }],
            }] : [],
            lifecycles: task.structuredLifecycleRequired ? [{
              title: "业务生命周期",
              summary: "从进入到处理完成",
              nodes: [
                { id: "start", label: "进入", detail: "开始处理", kind: "start" as const, factIds: ids },
                { id: "done", label: "完成", detail: "处理结束", kind: "terminal" as const, factIds: ids },
              ],
              edges: [{ from: "start", to: "done", label: "通过校验", kind: "normal" as const, factIds: ids }],
            }] : [],
            variantGroups: task.structuredLifecycleRequired ? [{
              title: "条件规则",
              summary: "保留当前切片中的条件",
              rules: [{ condition: "满足已知条件", outcome: "继续处理", factIds: ids }],
            }] : [],
            issues: task.structuredIssueReview ? [{
              title: "需要核对的行为",
              observation: "当前事实显示一条受条件约束的路径。",
              impact: "不满足条件时该操作不会继续。",
              status: "needs-confirmation" as const,
              factIds: [first],
            }] : [],
          };
        }),
      };
    };
    const common = {
      plan: executable.plan,
      readers,
      decisions: decisionsOf(executable.applicability),
      contractsByBlockId: new Map(PM_AUTHORED_BLOCKS.map((contract) => [contract.blockId, contract] as const)),
      language: "zh-CN",
      agent: { executor: "test", model: "fake", reasoningEffort: "low" as const },
      cacheDir,
      run: runner,
    };
    const first = await prepareBatchAuthor(common);
    const second = await prepareBatchAuthor(common);

    expect(first.structuredByTask.size).toBeGreaterThan(0);
    expect([...first.structuredByTask.values()].some((artifact) => artifact.issues.length > 0)).toBe(true);
    expect(first.agentCalls).toBe(first.structuredByTask.size);
    expect(second.agentCalls).toBe(0);
    expect(second.cacheHits).toBe(first.structuredByTask.size);
    expect(calls).toBe(first.structuredByTask.size);
    store.close();
  });
});

describe("bounded issue evidence", () => {
  const citation = (relPath: string, startLine: number, endLine = startLine) => ({
    rootName: "r1",
    relPath,
    startLine,
    endLine,
    startColumn: null,
    endColumn: null,
  });
  const fact = (
    factId: string,
    kind: string,
    value: unknown,
    relPath: string,
    startLine: number,
    endLine = startLine,
  ): CitedFact => ({
    factId,
    kind,
    value,
    citation: citation(relPath, startLine, endLine),
    resolutionClass: "declared",
  });

  it("keeps complete helper functions and their signals from the core flow package", () => {
    const routerPath = "features/leave/router.go";
    const helperPath = "features/leave/permissions.go";
    const unrelatedPath = "features/profile/preferences.go";
    const flow = fact("flow-core", "feature-flow", {
      featureName: "Approve leave",
      entryKey: "r1:POST /leave/approve",
      reportScopeRole: "core",
      steps: [{
        rootName: "r1",
        relPath: routerPath,
        label: "Approve",
        provenance: { source: citation(routerPath, 10) },
      }],
    }, routerPath, 10);
    const helper = {
      ...fact("excerpt-helper", "source-excerpt", {
        label: "permission",
        text: "func permission(actor, leave User) bool {\n  if actor.ID != leave.ID { return false }\n  return true\n}",
      }, helperPath, 40, 43),
      scopeRole: "core" as const,
    };
    const helperGuard = {
      ...fact("guard-helper", "guard", { test: "actor.ID != leave.ID" }, helperPath, 41),
      scopeRole: "core" as const,
    };
    const unrelated = fact("excerpt-unrelated", "source-excerpt", {
      label: "Preferences",
      text: "func Preferences() { return }",
    }, unrelatedPath, 5, 5);
    const request: AuthoringRequest = {
      taskId: "t",
      documentId: "module|leave|product",
      sectionId: "known-issues",
      blockId: "known-issues.impact",
      audience: "product",
      prompt: "",
      digest: "",
      facts: [flow, helper, helperGuard, unrelated],
    };

    const selected = boundedFactsFor(request).map((entry) => entry.factId);
    expect(selected).toContain("excerpt-helper");
    expect(selected).toContain("guard-helper");
    expect(selected).not.toContain("excerpt-unrelated");
  });

  it("keeps supporting closure out of module summary, rules, recovery and effects prose", () => {
    const core = { ...fact("core-data", "data-access", { entity: "leave" }, "features/leave/service.go", 10), scopeRole: "core" as const };
    const supporting = { ...fact("supporting-data", "data-access", { entity: "worklog" }, "features/support/service.go", 20), scopeRole: "supporting" as const };
    for (const blockId of ["module-responsibility.summary", "module-objects-rules-states.notes", "module-recovery.notes", "module-notifications-data.notes"]) {
      const request: AuthoringRequest = {
        taskId: blockId,
        documentId: "module|leave|product",
        sectionId: "module",
        blockId,
        audience: "product",
        prompt: "",
        digest: "",
        facts: [core, supporting],
      };
      expect(boundedFactsFor(request).map((entry) => entry.factId)).toEqual(["core-data"]);
    }
  });

  it("preserves material duration and attachment variants beyond the generic condition cap", () => {
    const ordinary = Array.from({ length: 60 }, (_, index) => fact(
      `condition-${index.toString().padStart(2, "0")}`,
      "condition",
      { subject: `ordinary-${index}`, test: `flag${index} == true`, literal: true },
      "features/leave/rules.go",
      100 + index,
    ));
    const bto = fact(
      "condition-bto-eight-hours",
      "condition",
      { subject: "duration", test: "leaveType == BTO && hours != 8", literal: 8, guarded: "rejects" },
      "features/leave/rules.go",
      20,
    );
    const attachment = fact(
      "guard-sick-attachment",
      "guard",
      { subject: "attachment", fullTest: "leaveType == Sick && hours > 8 && len(attachments) == 0", literal: 8, guarded: "rejects" },
      "features/leave/rules.go",
      30,
    );
    const namedVariants = ["pto", "uto", "special_leave", "maternity_leave", "prenatal_leave"].map((name, index) => fact(
      `condition-leave-type-${name}`,
      "condition",
      { subject: "leaveType", test: `leaveType === '${name}'`, operator: "===", literal: name },
      "features/leave/form.tsx",
      40 + index,
    ));
    const request: AuthoringRequest = {
      taskId: "lifecycle",
      documentId: "module|leave|product",
      sectionId: "module-flows-branches",
      blockId: "module-flows-branches.lifecycle",
      audience: "product",
      prompt: "",
      digest: "",
      facts: [...ordinary, bto, attachment, ...namedVariants],
    };

    const selected = boundedFactsFor(request).map((entry) => entry.factId);
    expect(selected).toContain("condition-bto-eight-hours");
    expect(selected).toContain("guard-sick-attachment");
    for (const variant of namedVariants) expect(selected).toContain(variant.factId);
    expect(selected.length).toBeGreaterThan(20);
  });

  it("preserves every approval threshold for the same field on an observed lifecycle", () => {
    const servicePath = "features/leave/service.go";
    const flow = fact("flow-approve", "feature-flow", {
      featureName: "Approve leave",
      method: "POST",
      steps: [{
        rootName: "r1",
        relPath: servicePath,
        label: "Approve",
        provenance: { source: citation(servicePath, 500) },
      }],
    }, servicePath, 500);
    const levelTwo = fact(
      "condition-hours-over-16",
      "condition",
      { subject: "lv.Hours", test: "lv.Hours > 16", operator: ">", literal: 16 },
      servicePath,
      510,
    );
    const levelThree = fact(
      "condition-hours-over-40",
      "condition",
      { subject: "lv.Hours", test: "lv.Hours > 40", operator: ">", literal: 40 },
      servicePath,
      557,
    );
    const levelThreeWrite = fact(
      "excerpt-approval-level-three",
      "source-excerpt",
      {
        label: "Approve (part 3)",
        text: "if lv.Hours > 40 && lastAprv.ApproveFlow == L2 { updateLvStatus(ctx, tx, lv.Id, LvWaitingL3ApproveC) }",
      },
      servicePath,
      540,
      570,
    );
    const legacyNoise = Array.from({ length: 100 }, (_, index) => fact(
      `legacy-${index.toString().padStart(3, "0")}`,
      "condition",
      { subject: `legacy-${index}`, test: `legacy${index} > ${index + 1}`, operator: ">", literal: index + 1 },
      "legacy/leave/service.go",
      10 + index,
    ));
    const request: AuthoringRequest = {
      taskId: "lifecycle-thresholds",
      documentId: "module|leave|product",
      sectionId: "module-flows-branches",
      blockId: "module-flows-branches.lifecycle",
      audience: "product",
      prompt: "",
      digest: "",
      facts: [flow, ...legacyNoise, levelTwo, levelThree, levelThreeWrite],
    };

    const selected = boundedFactsFor(request).map((entry) => entry.factId);
    expect(selected).toContain("condition-hours-over-16");
    expect(selected).toContain("condition-hours-over-40");
    expect(selected).toContain("excerpt-approval-level-three");
  });

  it("keeps lifecycle notification channels and representative outcome builders", () => {
    const path = "features/leave/notification.go";
    const notification = fact(
      "notification-email",
      "notification-call",
      { channel: "email", mechanism: "SES" },
      path,
      100,
    );
    const waitingSubject = fact(
      "excerpt-waiting-subject",
      "source-excerpt",
      { label: "waitingApprovedByLevelBuilder.subject", text: "return waiting approval subject" },
      path,
      110,
      118,
    );
    const waiting = fact(
      "excerpt-waiting-notification",
      "source-excerpt",
      { label: "waitingApprovedByLevelBuilder.BuildCpst", text: "NotifyEmailCpst and NotifyMobileCpst // mobile push notification" },
      path,
      120,
      170,
    );
    const rejected = fact(
      "excerpt-rejected-notification",
      "source-excerpt",
      { label: "rejectedBuilder.BuildCpst", text: "NotifyEmailCpst and NotifyMobileCpst // mobile push notification" },
      path,
      700,
      760,
    );
    const request: AuthoringRequest = {
      taskId: "lifecycle-notifications",
      documentId: "module|leave|product",
      sectionId: "module-flows-branches",
      blockId: "module-flows-branches.lifecycle",
      audience: "product",
      prompt: "",
      digest: "",
      facts: [notification, waitingSubject, waiting, rejected],
    };

    const selected = boundedFactsFor(request).map((entry) => entry.factId);
    expect(selected).toContain("notification-email");
    expect(selected).toContain("excerpt-waiting-notification");
    expect(selected).toContain("excerpt-rejected-notification");
    expect(selected.indexOf("excerpt-waiting-notification")).toBeLessThan(selected.indexOf("excerpt-waiting-subject"));
  });
});
