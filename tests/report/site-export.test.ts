import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authoredTasks, type GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { moduleTarget, projectTarget } from "../../engine/contracts/report/target.js";
import { openKnowledgeBase } from "../../engine/kb/query.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { exportProductReportSite } from "../../engine/report/site-export.js";
import { createSliceReaders } from "../../engine/report/slice-resolve.js";
import { insertBehaviorFact, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("exportProductReportSite", () => {
  it("writes one navigable project/module site and renders explicit branch conditions", () => {
    const store = seedStore();
    insertBehaviorFact(store, {
      factId: "role-values",
      kind: "value-set",
      relPath: "handlers/leave/service.go",
      startLine: 1,
      payload: {
        name: "RoleC",
        members: [
          { name: "EmployeeC", value: 1 },
          { name: "EmployeeF", value: "normal" },
          { name: "AdminC", value: 2 },
          { name: "AdminF", value: "admin" },
          { name: "SaleC", value: 3 },
          { name: "SaleF", value: "sale" },
          { name: "GeneralC", value: 4 },
          { name: "GeneralF", value: "normal" },
          { name: "ProjectManagerC", value: 5 },
          { name: "ProjectManagerF", value: "var(--bs-indigo)" },
          { name: "ProjectManagerCode", value: "project_management" },
        ],
      },
    });
    insertBehaviorFact(store, {
      factId: "header-values",
      kind: "value-set",
      relPath: "handlers/leave/service.go",
      startLine: 2,
      payload: {
        name: "HeaderC",
        members: [{ name: "Authorization", value: "Authorization" }],
      },
    });
    insertBehaviorFact(store, {
      factId: "role-admin-check",
      kind: "auth-annotation",
      relPath: "handlers/leave/service.go",
      startLine: 20,
      payload: { check: "authorization", mechanism: "role-membership", requirement: "AdminC" },
    });
    insertBehaviorFact(store, {
      factId: "role-general-check",
      kind: "auth-annotation",
      relPath: "handlers/leave/service.go",
      startLine: 21,
      payload: { check: "authorization", mechanism: "role-membership", requirement: "GeneralC" },
    });
    insertBehaviorFact(store, {
      factId: "header-authorization-check",
      kind: "auth-annotation",
      relPath: "handlers/leave/service.go",
      startLine: 22,
      payload: { check: "authorization", mechanism: "header", requirement: "Authorization" },
    });
    insertBehaviorFact(store, {
      factId: "role-project-manager-check",
      kind: "auth-annotation",
      relPath: "handlers/leave/service.go",
      startLine: 23,
      payload: { check: "authorization", mechanism: "role-membership", requirement: "ProjectManagerC" },
    });
    insertBehaviorFact(store, {
      factId: "role-sale-supporting-check",
      kind: "auth-annotation",
      relPath: "handlers/sales/service.go",
      startLine: 30,
      payload: { check: "authorization", mechanism: "role-membership", requirement: "SaleC" },
    });
    insertBehaviorFact(store, {
      factId: "leave-data",
      kind: "data-access",
      relPath: "handlers/leave/service.go",
      startLine: 40,
      payload: { entity: "leave", operation: "write" },
    });
    insertBehaviorFact(store, {
      factId: "worklog-supporting-data",
      kind: "data-access",
      relPath: "handlers/sales/service.go",
      startLine: 41,
      payload: { entity: "worklog", operation: "read" },
    });
    const kb = openKnowledgeBase(store);
    const membership = membershipOf("leave", ["handlers/leave/service.go", "handlers/sales/service.go"]);
    const readers = createSliceReaders(store, kb.snapshot.id, {
      ...membership,
      coreFiles: new Set(["r1/handlers/leave/service.go"]),
    });
    const snapshot: AnalysisSnapshotIdentity = { sourceIdentity: "s", codeGraphIdentity: "s", providerIdentity: "s", schemaVersion: "1", configIdentity: "s" };
    const params: GenerationParams = { executorKind: "test", modelId: "fake", language: "zh-CN" };
    const executable = compileExecutablePlan({ request: [projectTarget("product"), moduleTarget("leave", "product")], snapshot, params, analysisRunId: "run" });
    const flowTask = authoredTasks(executable.plan).find((task) => task.blockId === "module-flows-branches.flows")!;
    const lifecycleTask = authoredTasks(executable.plan).find((task) => task.blockId === "module-flows-branches.lifecycle")!;
    const issueTask = authoredTasks(executable.plan).find((task) => task.blockId === "known-issues.impact" && task.documentId.includes("module:leave"))!;
    const issueFact = {
      factId: "semantic|source-excerpt|leave-approve",
      kind: "source-excerpt",
      value: { label: "approve", text: "if status != pending { return error }" },
      citation: { rootName: "r1", relPath: "handlers/leave/service.go", startLine: 10, endLine: 12, startColumn: 1, endColumn: null },
      resolutionClass: "declared" as const,
    };
    const outDir = mkdtempSync(join(tmpdir(), "pa-product-site-"));
    temporary.push(outDir);
    const module = {
      id: "leave",
      sourceCandidateIds: ["leave"],
      rawNames: ["leaves"],
      displayName: "Leave 请假",
      summary: "员工提交请假并由审批人处理。",
      group: "员工自助",
      confidence: 0.96,
    };
    const result = exportProductReportSite({
      outDir,
      kb,
      readers,
      plan: executable.plan,
      proseStore: new Map([
        [issueTask.taskId, {
          prose: `源码审查形成一项待确认事项 [${issueFact.factId}]。`,
          groundedFactIds: [issueFact.factId],
          facts: [issueFact],
        }],
        [lifecycleTask.taskId, {
          prose: `生命周期由当前证据形成 [${issueFact.factId}]。`,
          groundedFactIds: [issueFact.factId],
          facts: [issueFact],
        }],
      ]),
      structuredByTask: new Map([
        [flowTask.taskId, {
          taskId: flowTask.taskId,
          markdown: "",
          issues: [],
          flowGroups: [{
            title: "提交与审批",
            summary: "申请进入审批流程",
            factIds: [],
            steps: [
              { label: "提交申请", detail: "填写时间与原因", factIds: [] },
              { label: "审批处理", detail: "记录处理结果", factIds: [] },
            ],
            branches: [
              { afterStep: 1, condition: "额度不足", outcome: "拒绝提交", kind: "rejection", factIds: [] },
              { afterStep: 2, condition: "校验通过", outcome: "申请进入审批", kind: "success", factIds: [] },
            ],
          }, {
            title: "共用辅助能力",
            summary: "提供三步辅助处理",
            factIds: [],
            steps: [
              { label: "接收请求", detail: "读取输入", factIds: [] },
              { label: "执行辅助处理", detail: "完成计算", factIds: [] },
              { label: "返回结果", detail: "交还调用方", factIds: [] },
            ],
            branches: [],
          }],
          lifecycles: [],
          variantGroups: [],
        }],
        [lifecycleTask.taskId, {
          taskId: lifecycleTask.taskId,
          markdown: "",
          flowGroups: [],
          lifecycles: [{
            title: "请假生命周期",
            summary: "从提交到审批结果",
            nodes: [
              { id: "submit", label: "提交申请", detail: "员工提交时间与原因", kind: "start", factIds: [issueFact.factId] },
              { id: "approved", label: "审批通过", detail: "流程进入完成状态", kind: "terminal", factIds: [issueFact.factId] },
            ],
            edges: [{ from: "submit", to: "approved", label: "审批人同意", kind: "normal", factIds: [issueFact.factId] }],
          }],
          variantGroups: [{
            title: "时长规则",
            summary: "不同请求受时长条件约束",
            rules: [{ condition: "超过规定额度", outcome: "拒绝提交", factIds: [issueFact.factId] }],
          }],
          issues: [],
        }],
        [issueTask.taskId, {
          taskId: issueTask.taskId,
          markdown: "",
          flowGroups: [],
          lifecycles: [],
          variantGroups: [],
          issues: [{
            title: "审批状态检查需要核对",
            observation: "处理路径仅接受待审批状态。",
            impact: "其他状态会在进入处理前终止。",
            status: "needs-confirmation" as const,
            factIds: [issueFact.factId],
          }],
        }],
      ]),
      classification: {
        schemaVersion: "module-classification.v2",
        sourceSnapshotId: "ident",
        candidateSetDigest: "digest",
        classifier: { executor: "test", model: "fake", contractVersion: "v2" },
        candidates: [{
          candidateId: "leave",
          classification: "product-module",
          confidence: 0.96,
          reason: "entry and object evidence",
          evidenceRefs: ["fact:module:leave"],
          status: "classified",
          displayName: "Leave 请假",
          summary: module.summary,
          group: module.group,
          includedCandidateIds: [],
        }],
      },
      boundedCandidates: [{
        candidateId: "leave",
        displayNameCandidates: ["leaves"],
        memberSummary: "one file",
        entrySummary: ["POST /leaves"],
        relationSummary: [],
        evidenceRefs: ["fact:module:leave"],
        reason: "formed from entry",
      }],
      modules: [module],
      selectedModules: [module],
      projectIncluded: true,
      language: "zh-CN",
    });

    const overview = readFileSync(join(outDir, "index.html"), "utf8");
    const detail = readFileSync(join(outDir, "modules/leave.html"), "utf8");
    expect(overview).toContain("全部功能模块");
    expect(overview).toContain("角色与参与方式");
    expect(overview).toContain("管理员");
    expect(overview).toContain("销售");
    expect(overview).not.toContain("<h3>Authorization</h3>");
    expect(overview).toContain("<h3>项目经理</h3>");
    expect(overview).not.toContain("var(--bs-indigo)");
    expect(overview.match(/<h3>普通员工<\/h3>/g)).toHaveLength(1);
    expect(overview).toContain("Leave 请假");
    expect(detail).toContain("提交与审批");
    expect(detail).toContain("额度不足");
    expect(detail).toContain("拒绝提交");
    expect(detail).toContain("申请进入审批");
    expect(detail).toContain("共用辅助能力");
    expect(detail).toContain("普通员工");
    expect(detail).toContain("管理员");
    expect(detail).not.toContain("<h3>销售</h3>");
    expect(detail).toContain("主要数据对象");
    expect(detail).toContain("主要数据对象</h3><p>leave</p>");
    expect(detail).not.toContain("主要数据对象</h3><p>worklog</p>");
    expect(detail).toContain("<td>模块身份</td><td class=\"coverage-ok\">有证据</td>");
    expect(detail).not.toContain("<h3>Authorization</h3>");
    expect(detail).toContain("<h3>项目经理</h3>");
    expect(detail).not.toContain("var(--bs-indigo)");
    expect(detail.match(/<h3>普通员工<\/h3>/g)).toHaveLength(1);
    expect(detail).toContain("参与角色与流程关系");
    expect(detail.match(/class="mermaid"/g)).toHaveLength(2);
    expect(detail).toContain("请假生命周期");
    expect(detail).toContain("时长规则");
    expect(detail).toContain("class=\"mermaid\"");
    expect(detail).toContain("审批状态检查需要核对");
    expect(detail).toContain("影响边界");
    expect(detail).toContain("项目概览");
    expect(result.manifest.outputFiles).toContain("assets/report.css");
    expect(result.manifest.outputFiles).toContain("assets/mermaid.min.js");
    expect(result.elapsedMs).toBeLessThan(5_000);
    store.close();
  });
});
