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
    const secondaryDecisionId = `behavioral|decision|r1|${relPath}:100|secondaryDecision`;
    for (const [name, line] of [["primaryDecision", 12], ["secondaryDecision", 100]] as const) {
      insertBehaviorFact(store, {
        factId: `behavioral|decision|r1|${relPath}:${line}|${name}`,
        kind: "decision",
        relPath,
        startLine: line,
        payload: { subject: name, text: `${name} chooses an outcome` },
      });
    }
    store.run(
      "INSERT INTO evidence_items (snapshot_id, source_root_id, kind, item_key, text, label, symbol_id, rel_path, start_line, start_column, resolution_class, confidence, end_line) VALUES (?, 1, 'source-excerpt', ?, ?, 'approvalAccess', NULL, ?, 200, 1, 'declared', NULL, 206)",
      [
        SNAPSHOT_ID,
        "r1|source-excerpt|handlers/leave/service.go|200|1|approvalAccess",
        "if isAdmin || isHr { status = WaitingApproval } else if isProjectManager { status = WaitingProjectReview } else { return forbidden }",
        relPath,
      ],
    );
    const flowPayload = (featureId: string, featureName: string, entryKey: string, line: number) => ({
      featureId,
      featureName,
      entryKey,
      steps: [{
        label: featureName,
        provenance: { source: { rootName: "r1", relPath, startLine: line, endLine: line, startColumn: null, endColumn: null } },
      }],
      diagram: "flowchart LR",
    });
    for (const [recordKey, featureId, featureName, entryKey, line] of [
      ["flow-leave", "feat_leave", "Leave", "r1:POST /leaves", 20],
      ["flow-jira-post", "feat_jira", "Jira", "r1:POST /jira/server", 30],
      ["flow-jira-put", "feat_jira", "Jira", "r1:PUT /jira/server", 40],
    ] as const) {
      store.run(
        "INSERT INTO derived_records (snapshot_id, kind, record_key, payload, subject_key) VALUES (?, 'feature-flow', ?, ?, ?)",
        [SNAPSHOT_ID, recordKey, JSON.stringify(flowPayload(featureId, featureName, entryKey, line)), featureId],
      );
    }
    const membership = {
      ...membershipOf("leave", [relPath]),
      entryKeys: new Set(["r1:POST /leaves", "r1:POST /jira/server", "r1:PUT /jira/server"]),
      coreEntryKeys: new Set(["r1:POST /leaves"]),
      featureIds: new Set(["feat_leave", "feat_jira"]),
    };
    const readers = createSliceReaders(store, SNAPSHOT_ID, membership);
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
    const startedBlockIds: string[] = [];
    let expectedLifecycleRepairIds: readonly string[] = [];
    const runner = async (agentRequest: { prompt: string }) => {
      calls += 1;
      const taskJson = agentRequest.prompt.split("Tasks:\n").at(-1)!.split("\n\nShared bounded fact table:")[0]!;
      const tasks = JSON.parse(taskJson) as { taskId: string; blockId: string; structuredFlowRequired: boolean; structuredLifecycleRequired: boolean; structuredIssueReview: boolean; factIds: string[] }[];
      expect(tasks).toHaveLength(1);
      startedBlockIds.push(tasks[0]!.blockId);
      return {
        tasks: tasks.map((task) => {
          const ids = task.factIds;
          const lifecycleRepairIds = task.structuredLifecycleRequired
            ? ids.filter((id) => id === secondaryDecisionId || id.includes("approvalAccess"))
            : [];
          if (task.structuredLifecycleRequired) expectedLifecycleRepairIds = lifecycleRepairIds;
          const first = ids[0]!;
          const lifecycleFirst = ids.find((id) => !lifecycleRepairIds.includes(id)) ?? first;
          const nearbyDecision = ids.find((id) => id.includes("primaryDecision")) ?? first;
          const coreFlow = ids.find((id) => id.includes("flow-leave")) ?? first;
          const jiraPostFlow = ids.find((id) => id.includes("flow-jira-post"));
          const foreign = "behavioral|condition|r1|handlers/leave/service.go|10|foreign";
          return {
            taskId: task.taskId,
            claims: [{ text: "该部分先检查条件! 然后继续处理!；最终由当前事实支持。", factIds: [first, foreign] }],
            flowGroups: task.structuredFlowRequired ? [
              {
                title: "主要流程",
                summary: "按已知条件处理",
                factIds: [coreFlow],
                steps: [{ label: "处理请求", detail: "读取当前事实", factIds: [coreFlow] }],
                branches: Array.from({ length: 10 }, (_, index) => ({
                  afterStep: 1,
                  condition: `已知条件 ${index + 1}`,
                  outcome: "继续处理",
                  kind: "conditional" as const,
                  factIds: [first, nearbyDecision, foreign],
                })),
              },
              ...(jiraPostFlow === undefined ? [] : [{
                title: "Jira 辅助能力",
                summary: "配置工时使用的 Jira 服务",
                factIds: [jiraPostFlow],
                steps: [{ label: "配置 Jira", detail: "保存服务配置", factIds: [jiraPostFlow] }],
                branches: [],
              }]),
            ] : [],
            lifecycles: task.structuredLifecycleRequired ? [{
              title: "业务生命周期",
              summary: "从进入到处理完成",
              nodes: [
                { id: "start", label: "进入", detail: "开始处理", kind: "start" as const, factIds: [...ids.filter((id) => !lifecycleRepairIds.includes(id)), foreign] },
                { id: "done", label: "完成", detail: "处理结束", kind: "terminal" as const, factIds: [lifecycleFirst] },
              ],
              edges: [{ from: "start", to: "done", label: "通过校验", kind: "normal" as const, factIds: [lifecycleFirst] }],
            }] : [],
            variantGroups: task.structuredLifecycleRequired ? [{
              title: "条件规则",
              summary: "保留当前切片中的条件",
              rules: [{ condition: "满足已知条件", outcome: "继续处理", factIds: [lifecycleFirst] }],
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
    let lifecycleRepairCalls = 0;
    const lifecycleRepairRunner = async (agentRequest: { prompt: string }) => {
      lifecycleRepairCalls += 1;
      expect(expectedLifecycleRepairIds).toHaveLength(2);
      for (const factId of expectedLifecycleRepairIds) {
        expect(agentRequest.prompt).toContain(factId);
        expect(agentRequest.prompt).toContain(`\"factId\":\"${factId}\"`);
      }
      return {
        rules: expectedLifecycleRepairIds.map((factId) => ({
          condition: factId.includes("approvalAccess") ? "角色和审批状态匹配" : "触发次级决策",
          outcome: factId.includes("approvalAccess") ? "允许查看对应审批记录" : "进入对应处理结果",
          factIds: [`[${factId}] «evidence copied from the prompt»`],
        })),
      };
    };
    let repairCalls = 0;
    const repairRunner = async (agentRequest: { prompt: string }) => {
      repairCalls += 1;
      expect(agentRequest.prompt).toContain(secondaryDecisionId);
      expect(agentRequest.prompt).toContain(`\"factId\":\"${secondaryDecisionId}\"`);
      return {
        branches: [{
          flowGroupIndex: 0,
          afterStep: 1,
          condition: "次级决策条件",
          outcome: "进入对应处理分支",
          kind: "conditional" as const,
          factIds: [`[${secondaryDecisionId}] «evidence copied from the prompt»`],
        }],
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
      repairRun: repairRunner,
      lifecycleRepairRun: lifecycleRepairRunner,
    };
    const first = await prepareBatchAuthor(common);
    const second = await prepareBatchAuthor(common);
    const agentTaskCount = first.taskMetrics.filter((task) => task.mode === "agent").length;

    expect(first.structuredByTask.size).toBeGreaterThan(0);
    expect([...first.structuredByTask.values()].some((artifact) => artifact.issues.length > 0)).toBe(true);
    expect(first.agentCalls).toBe(agentTaskCount + 2);
    expect(first.taskMetrics).toHaveLength(first.structuredByTask.size);
    expect(first.taskMetrics.every((task) => !task.cacheHit)).toBe(true);
    expect(first.taskMetrics.every((task) => task.mode === "deterministic" || task.attempts.at(-1)?.outcome === "validated")).toBe(true);
    expect(first.taskMetrics.some((task) => task.attempts.some((attempt) => attempt.kind === "flow-branch-repair"))).toBe(true);
    expect(first.taskMetrics.some((task) => task.attempts.some((attempt) =>
      attempt.kind === "flow-branch-repair" && attempt.normalizations.some((change) => change.startsWith("normalized repair fact ")),
    ))).toBe(true);
    expect(first.taskMetrics.some((task) => task.attempts.some((attempt) =>
      attempt.kind === "lifecycle-rule-repair" && attempt.normalizations.some((change) => change.startsWith("normalized lifecycle repair fact ")),
    ))).toBe(true);
    expect(first.taskMetrics.some((task) => (task.attempts[0]?.normalizations.length ?? 0) > 0)).toBe(true);
    expect(first.taskMetrics.some((task) => task.attempts[0]?.normalizations.some((change) =>
      change.includes("placed feature flow") && change.includes("flow-jira-put"),
    ))).toBe(true);
    expect([...first.structuredByTask.values()].some((artifact) => artifact.flowGroups.some((group) =>
      group.factIds.some((factId) => factId.includes("flow-jira-put")),
    ))).toBe(true);
    expect(second.agentCalls).toBe(0);
    expect(second.cacheHits).toBe(agentTaskCount);
    expect(second.taskMetrics).toHaveLength(first.structuredByTask.size);
    expect(second.taskMetrics.filter((task) => task.mode === "agent").every((task) => task.cacheHit && task.attempts.length === 0)).toBe(true);
    expect(second.taskMetrics.filter((task) => task.mode === "deterministic").every((task) => !task.cacheHit && task.attempts.length === 0)).toBe(true);
    expect(calls).toBe(agentTaskCount);
    expect(startedBlockIds).toEqual([
      "module-flows-branches.lifecycle",
      "module-flows-branches.flows",
      "known-issues.impact",
    ]);
    expect(repairCalls).toBe(1);
    expect(lifecycleRepairCalls).toBe(1);
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

  it("requires reader-visible flow branches but omits enum and notification plumbing decisions", () => {
    const path = "features/application/business-travel.go";
    const flow = fact("flow-application", "feature-flow", { featureName: "Business travel", steps: [] }, path, 1);
    const tripType = fact("decision-trip-type", "decision", { subject: "trip.Type" }, path, 20);
    const enumFormatting = fact("decision-enum-string", "decision", { subject: "u" }, "internal/constant/application.go", 30);
    const notifier = fact("decision-next-procedure", "decision", { subject: "r.NextProcedure" }, "features/application/notifier.go", 40);
    const empty = fact("decision-empty", "decision", { subject: "" }, path, 50);
    const guard = fact("guard-budget", "guard", { test: "amount > budget", message: "budget exceeded" }, path, 60);
    const loading = fact("guard-loading", "guard", { test: "!loaded || loading", message: "px-4 py-3" }, "features/application/Form.tsx", 70);
    const request: AuthoringRequest = {
      taskId: "flow",
      documentId: "module|application|product",
      sectionId: "module-flows-branches",
      blockId: "module-flows-branches.flows",
      audience: "product",
      prompt: "",
      digest: "",
      facts: [flow, tripType, enumFormatting, notifier, empty, guard, loading],
    };

    const selected = boundedFactsFor(request).map((entry) => entry.factId);
    expect(selected).toContain("flow-application");
    expect(selected).toContain("decision-trip-type");
    expect(selected).toContain("guard-budget");
    expect(selected).not.toContain("decision-enum-string");
    expect(selected).not.toContain("decision-next-procedure");
    expect(selected).not.toContain("decision-empty");
    expect(selected).not.toContain("guard-loading");
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

  it("admits a supporting state transition only when a scheduled task owns the same file", () => {
    const coreState = {
      ...fact("state-core", "state", { valueSet: "StatusC", label: "Applied", value: 0 }, "features/application/service.go", 20),
      scopeRole: "core" as const,
    };
    const unrelated = {
      ...fact("transition-unrelated", "state-transition", { field: "StatusC", trigger: "OnboardExternalUser", to: { valueSet: "StatusC", label: "Active" } }, "features/resourcepool/service.go", 40),
      scopeRole: "supporting" as const,
    };
    const scheduled = {
      ...fact("scheduled-expiry", "scheduled-task", { name: "expire applications" }, "jobs/application_expiry.go", 10),
      scopeRole: "supporting" as const,
    };
    const scheduledTransition = {
      ...fact("transition-expiry", "state-transition", { field: "StatusC", trigger: "ExpireApplications", to: { valueSet: "StatusC", label: "Expired" } }, "jobs/application_expiry.go", 30),
      scopeRole: "supporting" as const,
    };
    const scheduledExcerpt = {
      ...fact("excerpt-expiry", "source-excerpt", {
        label: "register expiry job",
        text: Array.from({ length: 40 }, (_, index) => index === 9 ? "schedule ExpireApplications" : "").join("\n"),
      }, "jobs/application_expiry.go", 1, 40),
      scopeRole: "supporting" as const,
    };
    const request: AuthoringRequest = {
      taskId: "lifecycle-supporting-transition",
      documentId: "module|application|product",
      sectionId: "module-flows-branches",
      blockId: "module-flows-branches.lifecycle",
      audience: "product",
      prompt: "",
      digest: "",
      facts: [coreState, unrelated, scheduled, scheduledTransition, scheduledExcerpt],
    };

    const selected = boundedFactsFor(request).map((entry) => entry.factId);
    expect(selected).toContain("transition-expiry");
    expect(selected).toContain("scheduled-expiry");
    expect(selected).toContain("excerpt-expiry");
    expect(selected).not.toContain("transition-unrelated");
  });

  it("omits presentation-only UI state without dropping business form variants", () => {
    const displayMode = fact(
      "condition-display-mode",
      "condition",
      { subject: "displayMode", test: "displayMode === 'month'", operator: "===", literal: "month" },
      "pages/worklog/Worklog.tsx",
      20,
    );
    const btoType = fact(
      "condition-bto-type",
      "condition",
      { subject: "leaveType", test: "leaveType === 'BTO'", operator: "===", literal: "BTO" },
      "pages/leave/LeaveForm.tsx",
      30,
    );
    const viewExcerpt = fact(
      "excerpt-worklog-view",
      "source-excerpt",
      { label: "Worklog", text: "function updateView() { return displayMode === 'month' ? 'Token Management' : 'Calendar' }" },
      "pages/worklog/Worklog.tsx",
      10,
      25,
    );
    const reactStateExcerpt = fact(
      "excerpt-worklog-react-state",
      "source-excerpt",
      { label: "LogTimeModal (part 1)", text: "const [typeState, setTypeState] = useState(type); setTypeState(type);" },
      "pages/worklog/LogTimeModal.tsx",
      40,
      60,
    );
    const tokenLabel = fact(
      "label-token-management",
      "ui-label",
      { text: "Token Management" },
      "pages/worklog/Worklog.tsx",
      22,
    );
    const request: AuthoringRequest = {
      taskId: "lifecycle-ui-presentation",
      documentId: "module|worklog|product",
      sectionId: "module-flows-branches",
      blockId: "module-flows-branches.lifecycle",
      audience: "product",
      prompt: "",
      digest: "",
      facts: [displayMode, btoType, viewExcerpt, reactStateExcerpt, tokenLabel],
    };

    const selected = boundedFactsFor(request).map((entry) => entry.factId);
    expect(selected).toContain("condition-bto-type");
    expect(selected).not.toContain("condition-display-mode");
    expect(selected).not.toContain("excerpt-worklog-view");
    expect(selected).not.toContain("excerpt-worklog-react-state");
    expect(selected).not.toContain("label-token-management");
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
