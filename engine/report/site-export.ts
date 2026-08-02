/**
 * Product-report HTML site export.
 *
 * This is a renderer over a frozen knowledge base and accepted authored
 * artifacts. It never opens analyzed source, never asks a model, and never
 * changes report facts. The same prepared run can therefore be exported again
 * (or printed to PDF) without paying analysis or authoring cost again.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { marked } from "marked";

import type { ModuleCandidate, ModuleClassificationArtifact } from "../contracts/module-classification/schema.js";
import { authoredTasks, type ReportPlan } from "../contracts/report/pipeline.js";
import { moduleScope, moduleTarget, projectTarget, targetKey } from "../contracts/report/target.js";
import type { KnowledgeBase } from "../kb/query.js";
import type { ProseArtifact, ProseStore } from "./authoring-host.js";
import type {
  StructuredFlowGroup,
  StructuredIssue,
  StructuredLifecycle,
  StructuredTaskArtifact,
  StructuredVariantGroup,
} from "./batch-author.js";
import type { ReportModule } from "./module-catalog.js";
import { resolveSliceFacts, type CitedFact, type SliceReaders } from "./slice-resolve.js";

const SITE_SCHEMA_VERSION = "product-report-site.v1";
const CSS_PATH = fileURLToPath(new URL("./site-assets/report.css", import.meta.url));
const JS_PATH = fileURLToPath(new URL("./site-assets/report.js", import.meta.url));
const MERMAID_PATH = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");

export interface ProductReportSiteMetrics {
  readonly analysisMs?: number;
  readonly classificationMs?: number;
  readonly authoringMs?: number;
  readonly exportMs?: number;
  readonly agentCalls?: number;
  readonly cacheHits?: number;
  readonly agentInputBytes?: number;
  readonly agentOutputBytes?: number;
}

export interface ExportProductReportSiteOptions {
  readonly outDir: string;
  readonly kb: KnowledgeBase;
  readonly readers: SliceReaders;
  readonly plan: ReportPlan;
  readonly proseStore: ProseStore;
  readonly structuredByTask: ReadonlyMap<string, StructuredTaskArtifact>;
  readonly classification: ModuleClassificationArtifact;
  readonly boundedCandidates: readonly ModuleCandidate[];
  /** Every product module in the overview, including ones without a detail page. */
  readonly modules: readonly ReportModule[];
  /** The module detail pages requested for this run. */
  readonly selectedModules: readonly ReportModule[];
  readonly projectIncluded: boolean;
  readonly language: string;
  readonly metrics?: ProductReportSiteMetrics;
}

export interface ProductReportSiteManifest {
  readonly schemaVersion: string;
  readonly projectName: string;
  readonly language: string;
  readonly audience: "product";
  readonly snapshotIdentity: string;
  readonly snapshotPublishedAt: string;
  readonly projectIncluded: boolean;
  readonly productModuleCount: number;
  readonly selectedModules: readonly { readonly id: string; readonly displayName: string; readonly file: string }[];
  readonly outputFiles: readonly string[];
  readonly metrics: ProductReportSiteMetrics;
}

export interface ProductReportSiteResult {
  readonly manifest: ProductReportSiteManifest;
  readonly manifestPath: string;
  readonly files: readonly string[];
  readonly elapsedMs: number;
}

function html(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slug(value: string): string {
  const normalized = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || `module-${Buffer.from(value).toString("hex").slice(0, 12)}`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : {};
}

function stringField(value: unknown, ...fields: readonly string[]): string | null {
  const record = asRecord(value);
  for (const field of fields) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    if (typeof candidate === "number") return String(candidate);
  }
  return null;
}

function arrayField(value: unknown, field: string): readonly unknown[] {
  const candidate = asRecord(value)[field];
  return Array.isArray(candidate) ? candidate : [];
}

function unique(values: Iterable<string>, cap = Number.POSITIVE_INFINITY): readonly string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort().slice(0, cap);
}

function uniqueFacts(facts: Iterable<CitedFact>): readonly CitedFact[] {
  return [...new Map([...facts].map((fact) => [fact.factId, fact] as const)).values()];
}

function readableIdentifier(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function roleIdentity(value: string): string {
  return value
    .replace(/Code$/i, "")
    .replace(/[CF]$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function readableRole(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const known: Readonly<Record<string, string>> = {
    normal: "普通员工",
    employee: "普通员工",
    admin: "管理员",
    projectmanagement: "项目经理",
    projectmanager: "项目经理",
    hrspecialist: "HR 专员",
    hr: "HR 专员",
    reviewadmin: "评审管理员",
    reviewmanager: "评审经理",
    client: "客户",
    systemadmin: "系统管理员",
    sale: "销售",
    sales: "销售",
    rateadmin: "费率管理员",
    officemanagement: "办公室管理",
    invoicemanager: "发票管理员",
  };
  return known[normalized] ?? readableIdentifier(value);
}

interface RoleDefinition {
  readonly identity: string;
  readonly label: string;
  readonly raw: readonly string[];
  readonly evidence: readonly CitedFact[];
}

function roleDefinitions(options: ExportProductReportSiteOptions): readonly RoleDefinition[] {
  const scope = projectTarget("product").scope;
  const auth = resolveSliceFacts(options.readers, scope, ["auth-annotation"]);
  const requirementIdentities = new Set(auth
    .map((fact) => stringField(fact.value, "requirement"))
    .filter((value): value is string => value !== null)
    .map(roleIdentity));
  const sets = resolveSliceFacts(options.readers, scope, ["value-set"])
    .filter((fact) => arrayField(fact.value, "members").some((member) => {
      const name = stringField(member, "name");
      return name !== null && requirementIdentities.has(roleIdentity(name));
    }));
  const members = sets.flatMap((fact) => arrayField(fact.value, "members").map((member) => ({ fact, member })));
  const byIdentity = new Map<string, RoleDefinition>();
  for (const { fact, member } of members) {
    const name = stringField(member, "name");
    if (name === null) continue;
    const identity = roleIdentity(name);
    const same = members.filter((candidate) => {
      const candidateName = stringField(candidate.member, "name");
      return candidateName !== null && roleIdentity(candidateName) === identity;
    });
    const readableValue = same
      .map((candidate) => asRecord(candidate.member).value)
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const raw = unique(same.flatMap((candidate) => {
      const candidateName = stringField(candidate.member, "name");
      const value = asRecord(candidate.member).value;
      return [candidateName ?? "", typeof value === "string" ? value : ""];
    }), 6);
    const current = byIdentity.get(identity);
    byIdentity.set(identity, {
      identity,
      label: readableRole(readableValue ?? name),
      raw,
      evidence: current === undefined ? [fact] : uniqueFacts([...current.evidence, fact]),
    });
  }
  return [...byIdentity.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function roleMap(
  options: ExportProductReportSiteOptions,
  moduleId?: string,
  flowGroups: readonly StructuredFlowGroup[] = [],
  lifecycles: readonly StructuredLifecycle[] = [],
  lifecycleArtifact: ProseArtifact | null = null,
): string {
  const scope = moduleId === undefined ? projectTarget("product").scope : moduleScope(moduleId);
  // A report module may contain supporting files reached through a real call
  // path. Those files are useful for explaining an end-to-end flow, but their
  // own authorization checks belong to the capability that owns them. Project
  // scope keeps every observed role; module scope names only roles checked in
  // the module's canonical source boundary.
  const auth = resolveSliceFacts(options.readers, scope, ["auth-annotation"])
    .filter((fact) => moduleId === undefined || fact.scopeRole === "core");
  const byIdentity = new Map<string, CitedFact[]>();
  for (const fact of auth) {
    const requirement = stringField(fact.value, "requirement");
    if (requirement === null) continue;
    const identity = roleIdentity(requirement);
    const facts = byIdentity.get(identity) ?? [];
    facts.push(fact);
    byIdentity.set(identity, facts);
  }
  const definitions = roleDefinitions(options);
  const employee = definitions.find((definition) => definition.identity === "employee" || definition.raw.some((value) => value.toLowerCase() === "normal"));
  const selected = definitions.filter((definition) => byIdentity.has(definition.identity));
  if ((moduleId === undefined ? options.modules.length > 0 : flowGroups.length > 0) && employee !== undefined && !selected.some((definition) => definition.identity === employee.identity)) {
    selected.unshift(employee);
  }
  const cards = selected
    .sort((a, b) => {
      const employeeRank = (definition: RoleDefinition) => definition.identity === employee?.identity ? 0 : 1;
      return employeeRank(a) - employeeRank(b) || (byIdentity.get(b.identity)?.length ?? 0) - (byIdentity.get(a.identity)?.length ?? 0) || a.label.localeCompare(b.label);
    })
    .slice(0, moduleId === undefined ? 14 : 8)
    .map((definition) => {
      const checks = byIdentity.get(definition.identity) ?? [];
      const operations = unique(flowGroups.map((group) => group.title), 5);
      const detail = checks.length > 0
        ? `在当前范围的 ${checks.length} 处权限检查中被明确引用。`
        : operations.length > 0
          ? `可通过已观测入口参与：${operations.join("、")}。`
          : "角色编码中定义的通用登录用户身份。";
      return `<article><h3>${html(definition.label)}</h3><p>${html(detail)}</p><small>${html(definition.raw.join(" / "))}</small>${evidence(uniqueFacts([...definition.evidence, ...checks]), "查看角色定义与权限证据", 5)}</article>`;
    });
  if (moduleId !== undefined && lifecycleArtifact !== null) {
    const participants = lifecycles.flatMap((lifecycle) => lifecycle.nodes)
      .filter((node) => {
        if (node.kind === "terminal") return false;
        const text = `${node.label} ${node.detail}`;
        const namesAParticipant = /approver|审批人|负责人|经理|\bHR\b|人力资源/i.test(text);
        const isApprovalState = node.kind === "state" && /await(?:ing)? approval|pending approval|等待[^。；]*审批|待[^。；]*审批/i.test(text);
        return namesAParticipant || isApprovalState;
      });
    if (participants.length > 0) {
      const byId = new Map(lifecycleArtifact.facts.map((fact) => [fact.factId, fact] as const));
      const facts = unique(participants.flatMap((node) => node.factIds))
        .map((id) => byId.get(id))
        .filter((fact): fact is CitedFact => fact !== undefined);
      cards.push(`<article><h3>流程审批参与者</h3><p>${html(unique(participants.map((node) => node.detail), 5).join("；"))}</p><small>由当前生命周期关系确定</small>${evidence(facts, "查看审批关系证据", 6)}</article>`);
    }
  }
  if (cards.length === 0) {
    return `<p class="callout unknown"><strong>角色名称未解析</strong>当前范围存在入口，但没有把权限标识关联到可读的角色定义；报告不以猜测补齐。</p>`;
  }
  return `<div class="role-map">${cards.join("")}</div>`;
}

function citationLabel(fact: CitedFact): string {
  const line = fact.citation.startLine === null ? "" : `:${fact.citation.startLine}`;
  return `${fact.citation.rootName}/${fact.citation.relPath}${line}`;
}

function evidence(facts: readonly CitedFact[], label = "查看源码证据", cap = 16): string {
  const citations = unique(facts.map(citationLabel), cap);
  if (citations.length === 0) return "";
  return `<details class="evidence"><summary>${html(label)}</summary><ul>${citations
    .map((citation) => `<li><code>${html(citation)}</code></li>`)
    .join("")}</ul></details>`;
}

function removeMarkers(markdown: string, artifact: ProseArtifact): string {
  let cleaned = markdown;
  for (const fact of artifact.facts) cleaned = cleaned.replaceAll(`[${fact.factId}]`, "");
  return cleaned
    .replaceAll(/\[\d+\]/g, "")
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/[ \t]+([。！？.!?，,；;：:])/g, "$1")
    .trim();
}

function proseHtml(artifact: ProseArtifact | null): string {
  if (artifact === null) return "";
  const rendered = marked.parse(removeMarkers(artifact.prose, artifact), { async: false, gfm: true });
  return `<div class="authored-prose">${String(rendered)}</div>${evidence(
    artifact.facts.filter((fact) => artifact.groundedFactIds.includes(fact.factId)),
  )}`;
}

function prosePlain(artifact: ProseArtifact | null, fallback: string): string {
  if (artifact === null) return fallback;
  const text = removeMarkers(artifact.prose, artifact)
    .replaceAll(/[`*_>#]/g, "")
    .replaceAll(/\[[^\]]+\]\([^\)]+\)/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (text === "") return fallback;
  if (text.length <= 280) return text;
  const clipped = text.slice(0, 280);
  const sentenceEnd = Math.max(clipped.lastIndexOf("。"), clipped.lastIndexOf("！"), clipped.lastIndexOf("？"));
  return sentenceEnd >= 100 ? clipped.slice(0, sentenceEnd + 1) : `${clipped.trimEnd()}…`;
}

interface ArtifactIndex {
  readonly prose: (documentId: string, blockId: string) => ProseArtifact | null;
  readonly structured: (documentId: string, blockId: string) => StructuredTaskArtifact | null;
}

function artifactIndex(options: ExportProductReportSiteOptions): ArtifactIndex {
  const taskByKey = new Map(authoredTasks(options.plan).map((task) => [`${task.documentId}\0${task.blockId}`, task] as const));
  const task = (documentId: string, blockId: string) => taskByKey.get(`${documentId}\0${blockId}`);
  return {
    prose(documentId, blockId) {
      const found = task(documentId, blockId);
      return found === undefined ? null : (options.proseStore.get(found.taskId) ?? null);
    },
    structured(documentId, blockId) {
      const found = task(documentId, blockId);
      return found === undefined ? null : (options.structuredByTask.get(found.taskId) ?? null);
    },
  };
}

function section(id: string, number: number, title: string, subtitle: string, body: string): string {
  return `<section class="report-section" id="${html(id)}"><header class="section-title"><span>${String(number).padStart(2, "0")}</span><div><h2>${html(title)}</h2><p>${html(subtitle)}</p></div></header>${body}</section>`;
}

function meta(items: readonly [string, string][]): string {
  return `<div class="hero-meta">${items.map(([label, value]) => `<div><strong>${html(label)}</strong><span>${html(value)}</span></div>`).join("")}</div>`;
}

function candidateName(
  classification: ModuleClassificationArtifact,
  candidates: readonly ModuleCandidate[],
  id: string,
): string {
  const result = classification.candidates.find((candidate) => candidate.candidateId === id);
  const input = candidates.find((candidate) => candidate.candidateId === id);
  return result?.displayName ?? input?.displayNameCandidates[0] ?? id;
}

function classifiedNames(options: ExportProductReportSiteOptions, kind: string, cap = 20): readonly string[] {
  return unique(
    options.classification.candidates
      .filter((candidate) => candidate.status === "classified" && candidate.classification === kind)
      .map((candidate) => candidateName(options.classification, options.boundedCandidates, candidate.candidateId)),
    cap,
  );
}

function pagePath(module: ReportModule): string {
  return `modules/${slug(module.id)}.html`;
}

function groupModules(modules: readonly ReportModule[]): readonly (readonly [string, readonly ReportModule[]])[] {
  const groups = new Map<string, ReportModule[]>();
  for (const module of modules) {
    const key = module.group.trim() || "其他";
    const list = groups.get(key) ?? [];
    list.push(module);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([group, list]) => [group, [...list].sort((a, b) => a.displayName.localeCompare(b.displayName))] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}

interface PageContext {
  readonly options: ExportProductReportSiteOptions;
  readonly projectName: string;
  readonly generatedDate: string;
  readonly current: "project" | string;
  readonly depth: 0 | 1;
  readonly title: string;
  readonly sectionLinks: readonly [string, string][];
}

function navigation(context: PageContext): string {
  const prefix = context.depth === 0 ? "" : "../";
  const projectLink = context.options.projectIncluded
    ? `<a class="nav-primary ${context.current === "project" ? "active" : ""}" href="${prefix}index.html"><span>项目概览</span><em>完整功能地图</em></a>`
    : "";
  const children = context.sectionLinks.length === 0
    ? ""
    : `<div class="nav-children">${context.sectionLinks.map(([id, label]) => `<a href="#${html(id)}" data-section-link="${html(id)}">${html(label)}</a>`).join("")}</div>`;
  const modules = context.options.selectedModules.map((module) => {
    const active = context.current === module.id ? "active" : "";
    return `<a class="nav-primary ${active}" href="${prefix}${pagePath(module)}"><span>${html(module.displayName)}</span><em>业务详情</em></a>`;
  }).join("");
  const home = context.options.projectIncluded
    ? `${prefix}index.html`
    : `${prefix}${pagePath(context.options.selectedModules[0]!)}`;
  const initial = html((context.projectName.trim()[0] ?? "P").toUpperCase());
  return `<aside class="sidebar" id="sidebar"><div class="sidebar-head"><a href="${home}" class="report-mark" aria-label="返回报告入口"><span>${initial}</span><strong>${html(context.projectName)}<br><small>非技术报告</small></strong></a><button class="sidebar-close" data-sidebar-close aria-label="关闭导航">×</button></div><nav class="report-nav" aria-label="报告导航"><div class="nav-label">项目</div>${projectLink}${context.current === "project" ? children : ""}<div class="nav-label module-label">模块详情</div>${modules}${context.current === "project" ? "" : children}<div class="nav-label source-label">报告依据</div><div class="nav-note">仅使用已发布的源码分析快照<br>生成于 ${html(context.generatedDate)}</div></nav></aside>`;
}

function documentShell(context: PageContext, body: string): string {
  const prefix = context.depth === 0 ? "" : "../";
  const projectHref = context.options.projectIncluded ? `${prefix}index.html` : "#";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="report-audience" content="product"><title>${html(context.title)}</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23132238'/><text x='16' y='22' text-anchor='middle' font-size='18' fill='white'>${html((context.projectName[0] ?? "P").toUpperCase())}</text></svg>"><link rel="stylesheet" href="${prefix}assets/report.css"></head><body><div class="progress" id="reading-progress"></div>${navigation(context)}<div class="scrim" data-sidebar-close></div><div class="app-shell"><header class="topbar"><button class="menu-button" data-sidebar-open aria-label="打开导航"><span></span><span></span><span></span></button><div class="crumb"><a href="${projectHref}">${html(context.projectName)}</a><span>/</span><strong>${html(context.current === "project" ? "项目概览" : context.title)}</strong></div><button class="print-button" data-print>打印 / PDF</button></header><main class="report-main">${body}</main><footer class="report-footer"><span>${html(context.projectName)} 源码理解报告 · 中文非技术版</span><span>只陈述当前分析快照可支持的事实</span></footer></div><script src="${prefix}assets/mermaid.min.js"></script><script src="${prefix}assets/report.js"></script></body></html>`;
}

function diagramLabel(value: string, cap = 88): string {
  const compact = value.replaceAll(/\s+/g, " ").trim().slice(0, cap);
  return compact.replaceAll('"', "'").replaceAll("<", "＜").replaceAll(">", "＞").replaceAll("`", "'");
}

function flowMermaid(group: StructuredFlowGroup, groupIndex: number): string {
  const prefix = `f${groupIndex}_`;
  const lines = [
    "flowchart TD",
    "classDef action fill:#eef5ff,stroke:#4776c5,color:#172b4d,stroke-width:1px",
    "classDef success fill:#eaf8f1,stroke:#2f855a,color:#184c35",
    "classDef reject fill:#fff0ee,stroke:#c75c50,color:#7f2922",
    "classDef conditional fill:#fff8e5,stroke:#c88a22,color:#6f4a0b",
    "classDef unknown fill:#f2f4f7,stroke:#7a8699,color:#344054,stroke-dasharray:4 3",
  ];
  group.steps.forEach((step, index) => {
    lines.push(`${prefix}s${index}["${diagramLabel(`${index + 1}. ${step.label}`)}"]:::action`);
    if (index > 0) lines.push(`${prefix}s${index - 1} --> ${prefix}s${index}`);
  });
  group.branches.forEach((branch, index) => {
    const source = Math.max(0, Math.min(group.steps.length - 1, branch.afterStep - 1));
    const style = branch.kind === "rejection" || branch.kind === "exception"
      ? "reject"
      : branch.kind === "success"
        ? "success"
        : branch.kind === "unknown"
          ? "unknown"
          : "conditional";
    const arrow = branch.kind === "unknown" ? "-.->" : "-->";
    lines.push(`${prefix}b${index}["${diagramLabel(branch.outcome, 104)}"]:::${style}`);
    lines.push(`${prefix}s${source} ${arrow}|"${diagramLabel(branch.condition, 104)}"| ${prefix}b${index}`);
  });
  return lines.join("\n");
}

function flowNeedsDiagram(group: StructuredFlowGroup): boolean {
  const branchPoints = new Set(group.branches.map((branch) => branch.afterStep));
  return group.steps.length >= 4 || group.branches.length >= 2 || branchPoints.size >= 2;
}

function flowLanes(groups: readonly StructuredFlowGroup[], facts: readonly CitedFact[]): string {
  if (groups.length === 0) return `<p class="callout unknown"><strong>流程证据不足</strong>当前事实切片没有形成可核对的主要流程，报告不以猜测补齐。</p>`;
  const byId = new Map(facts.map((fact) => [fact.factId, fact] as const));
  return `<div class="flow-lanes">${groups.map((group, groupIndex) => {
    const steps = group.steps.map((step, index) => `<div class="flow-step"><b>${groupIndex + 1}.${index + 1}</b><span>${html(step.label)}</span>${step.detail.trim() === "" ? "" : `<small>${html(step.detail)}</small>`}</div>`).join("");
    const branches = group.branches.map((branch) => `<div class="flow-branch ${html(branch.kind)}"><strong>${html(branch.kind === "rejection" ? "拒绝 / 终止" : branch.kind === "success" ? "成功" : branch.kind === "exception" ? "异常" : branch.kind === "conditional" ? "条件分支" : "待确认")}</strong><span>${html(branch.condition)} → ${html(branch.outcome)}</span></div>`).join("");
    const groupFacts = unique([
      ...group.factIds,
      ...group.steps.flatMap((step) => step.factIds),
      ...group.branches.flatMap((branch) => branch.factIds),
    ]).map((id) => byId.get(id)).filter((fact): fact is CitedFact => fact !== undefined);
    const fallback = `<div class="flow-steps">${steps}</div>${branches === "" ? "" : `<div class="flow-branches">${branches}</div>`}`;
    const presentation = flowNeedsDiagram(group)
      ? `<div class="diagram-frame"><pre class="mermaid">${html(flowMermaid(group, groupIndex))}</pre></div><details class="flow-text"><summary>查看文字版流程与条件</summary>${fallback}</details>`
      : `<div class="simple-flow" aria-label="简要流程">${fallback}</div>`;
    return `<article class="flow-lane"><header><span>F${String(groupIndex + 1).padStart(2, "0")}</span><div><h3>${html(group.title)}</h3><p>${html(group.summary)}</p></div></header>${presentation}${evidence(groupFacts, "查看此流程证据", 8)}</article>`;
  }).join("")}</div>`;
}

function lifecycleMermaid(lifecycle: StructuredLifecycle, lifecycleIndex: number): string {
  const prefix = `lc${lifecycleIndex}_`;
  const nodeMap = new Map(lifecycle.nodes.map((node, index) => [node.id, `${prefix}n${index}`] as const));
  const lines = [
    "flowchart TD",
    "classDef action fill:#eef5ff,stroke:#4776c5,color:#172b4d",
    "classDef state fill:#f1edff,stroke:#7457b8,color:#3f2a73",
    "classDef decision fill:#fff8e5,stroke:#c88a22,color:#6f4a0b",
    "classDef terminal fill:#eaf8f1,stroke:#2f855a,color:#184c35,stroke-width:2px",
    "classDef unknown fill:#f2f4f7,stroke:#7a8699,color:#344054,stroke-dasharray:4 3",
  ];
  lifecycle.nodes.forEach((node, index) => {
    const id = `${prefix}n${index}`;
    const label = diagramLabel(node.label);
    const shape = node.kind === "start" || node.kind === "terminal"
      ? `${id}(["${label}"])`
      : node.kind === "decision"
        ? `${id}{"${label}"}`
        : `${id}["${label}"]`;
    const style = node.kind === "state" ? "state" : node.kind === "decision" ? "decision" : node.kind === "terminal" ? "terminal" : node.kind === "unknown" ? "unknown" : "action";
    lines.push(`${shape}:::${style}`);
  });
  lifecycle.edges.forEach((edge) => {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (from === undefined || to === undefined) return;
    const arrow = edge.kind === "unknown" || edge.kind === "recovery" ? "-.->" : "-->";
    lines.push(`${from} ${arrow}|"${diagramLabel(edge.label, 104)}"| ${to}`);
  });
  return lines.join("\n");
}

function lifecycleAndVariants(
  lifecycles: readonly StructuredLifecycle[],
  variants: readonly StructuredVariantGroup[],
  artifact: ProseArtifact | null,
): string {
  if (lifecycles.length === 0 || artifact === null) {
    return `<p class="callout unknown"><strong>生命周期证据不足</strong>当前结构化作者没有形成可核对的完整生命周期，报告不以猜测补齐。</p>`;
  }
  const byId = new Map(artifact.facts.map((fact) => [fact.factId, fact] as const));
  const lifecycleHtml = lifecycles.map((lifecycle, index) => {
    const facts = unique([
      ...lifecycle.nodes.flatMap((node) => node.factIds),
      ...lifecycle.edges.flatMap((edge) => edge.factIds),
    ]).map((id) => byId.get(id)).filter((fact): fact is CitedFact => fact !== undefined);
    const text = `<ol class="lifecycle-text">${lifecycle.nodes.map((node) => `<li><strong>${html(node.label)}</strong><span>${html(node.detail)}</span></li>`).join("")}</ol>`;
    return `<article class="lifecycle-card"><header><span>L${String(index + 1).padStart(2, "0")}</span><div><h3>${html(lifecycle.title)}</h3><p>${html(lifecycle.summary)}</p></div></header><div class="diagram-frame lifecycle-diagram"><pre class="mermaid">${html(lifecycleMermaid(lifecycle, index))}</pre></div><details class="flow-text"><summary>查看文字版生命周期</summary>${text}</details>${evidence(facts, "查看生命周期证据", 12)}</article>`;
  }).join("");
  const variantHtml = variants.length === 0 ? "" : `<div class="variant-groups">${variants.map((group) => {
    const facts = unique(group.rules.flatMap((rule) => rule.factIds)).map((id) => byId.get(id)).filter((fact): fact is CitedFact => fact !== undefined);
    return `<article class="variant-group"><header><h3>${html(group.title)}</h3><p>${html(group.summary)}</p></header><table><thead><tr><th>适用条件</th><th>源码可确认的处理</th></tr></thead><tbody>${group.rules.map((rule) => `<tr><td>${html(rule.condition)}</td><td>${html(rule.outcome)}</td></tr>`).join("")}</tbody></table>${evidence(facts, "查看该组规则证据", 12)}</article>`;
  }).join("")}</div>`;
  return `<div class="lifecycle-cards">${lifecycleHtml}</div>${variantHtml}`;
}

function capabilityMap(options: ExportProductReportSiteOptions): string {
  const selected = new Map(options.selectedModules.map((module) => [module.id, module] as const));
  const groups = groupModules(options.modules).map(([group, modules]) => `<article class="capability-group"><h3>${html(group)}</h3><p>${modules.length} 个由入口、业务对象和关系证据支持的功能模块。</p><div class="module-list">${modules.map((module) => {
    const detail = selected.get(module.id);
    return `<div class="module-item"><strong>${html(module.displayName)}</strong><p>${html(module.summary)}</p>${detail === undefined ? "" : `<a href="${pagePath(detail)}">查看模块详情 →</a>`}</div>`;
  }).join("")}</div></article>`).join("");
  const aggregate = classifiedNames(options, "aggregate-surface");
  const infrastructure = classifiedNames(options, "infrastructure");
  const external = classifiedNames(options, "external-system");
  const unresolved = options.classification.candidates
    .filter((candidate) => candidate.status === "unresolved")
    .map((candidate) => candidateName(options.classification, options.boundedCandidates, candidate.candidateId));
  const rails = [
    aggregate.length === 0 ? "" : `<aside class="external-rail"><h3>聚合入口，不重复计为业务模块</h3><p>${html(aggregate.join(" · "))}</p></aside>`,
    infrastructure.length === 0 ? "" : `<aside class="external-rail"><h3>平台与基础能力</h3><p>${html(infrastructure.join(" · "))}</p></aside>`,
    external.length === 0 ? "" : `<aside class="external-rail"><h3>外部依赖，不计为项目功能模块</h3><p>${html(external.join(" · "))}</p></aside>`,
    unresolved.length === 0 ? "" : `<aside class="external-rail"><h3>分类未决，不静默归入功能模块</h3><p>${html(unique(unresolved, 30).join(" · "))}</p></aside>`,
  ].join("");
  return `<div class="capability-map">${groups}</div>${rails}`;
}

function architecture(options: ExportProductReportSiteOptions): string {
  const context = options.kb.runContext();
  const languagesByRoot = new Map<string, Set<string>>();
  for (const file of options.kb.sourceFiles()) {
    if (file.language === null) continue;
    const languages = languagesByRoot.get(file.rootName) ?? new Set<string>();
    languages.add(file.language);
    languagesByRoot.set(file.rootName, languages);
  }
  const roots = context?.roots.map((root) => ({
    title: root.name,
    detail: `${[...(languagesByRoot.get(root.name) ?? [])].sort().join(" / ") || "语言未识别"} · ${root.analyzed} 个文件`,
  })) ?? [];
  const groups = groupModules(options.modules).map(([group, modules]) => ({ title: group, detail: modules.map((module) => module.displayName).slice(0, 5).join(" · ") }));
  const accessCounts = new Map<string, number>();
  for (const access of options.kb.dataAccess()) {
    if (access.entity !== null) accessCounts.set(access.entity, (accessCounts.get(access.entity) ?? 0) + 1);
  }
  const entities = [...accessCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([name, count]) => ({ title: readableIdentifier(name), detail: `${count} 处已观察到的数据访问` }));
  const external = unique([
    ...classifiedNames(options, "external-system", 12),
    ...options.kb.mapEdges().filter((edge) => edge.kind === "external").map((edge) => edge.to),
  ], 12).map((name) => ({ title: readableIdentifier(name), detail: "外部调用或边界证据" }));
  const layer = (label: string, nodes: readonly { title: string; detail: string }[]) => `<div class="architecture-layer"><div class="architecture-label">${html(label)}</div><div class="architecture-nodes">${nodes.map((node) => `<div class="architecture-node"><strong>${html(node.title)}</strong><span>${html(node.detail)}</span></div>`).join("")}</div></div>`;
  return `<div class="architecture" role="img" aria-label="项目结构图">${layer("源码组成", roots)}<div class="architecture-arrow">↓</div>${layer("业务能力", groups)}<div class="architecture-arrow">↓</div>${layer("核心数据对象", entities)}<div class="architecture-arrow">↓</div>${layer("外部触点", external)}</div>`;
}

function projectJourneys(groups: readonly StructuredFlowGroup[], facts: readonly CitedFact[]): string {
  if (groups.length === 0) return flowLanes(groups, facts);
  const rendered = groups.map((group, groupIndex) => `<article class="journey"><header><h3>${html(group.title)}</h3><p>${html(group.summary)}</p></header><div><div class="journey-steps">${group.steps.map((step, index) => `<div class="journey-step"><b>${groupIndex + 1}.${index + 1}</b>${html(step.label)}</div>`).join("")}</div>${group.branches.length === 0 ? "" : `<div class="flow-branches">${group.branches.map((branch) => `<div class="flow-branch ${html(branch.kind)}"><strong>${html(branch.kind)}</strong>${html(branch.condition)} → ${html(branch.outcome)}</div>`).join("")}</div>`}</div></article>`).join("");
  return `<div class="journey-map">${rendered}</div>${evidence(facts, "查看业务路径证据", 16)}`;
}

function projectObjects(options: ExportProductReportSiteOptions): string {
  const accessByEntity = new Map<string, { reads: number; writes: number; roots: Set<string> }>();
  for (const access of options.kb.dataAccess()) {
    if (access.entity === null) continue;
    const current = accessByEntity.get(access.entity) ?? { reads: 0, writes: 0, roots: new Set<string>() };
    if (access.operation === "read") current.reads += 1;
    else current.writes += 1;
    current.roots.add(access.rootName);
    accessByEntity.set(access.entity, current);
  }
  const cards = [...accessByEntity.entries()]
    .sort((a, b) => (b[1].reads + b[1].writes) - (a[1].reads + a[1].writes) || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, stats]) => `<article><h3>${html(readableIdentifier(name))}</h3><p>${stats.reads} 处读取、${stats.writes} 处写入或变更。</p><small>涉及 ${html([...stats.roots].sort().join(" · "))}</small></article>`)
    .join("");
  return cards === ""
    ? `<p class="callout unknown"><strong>对象证据不足</strong>当前分析没有形成可归属的数据对象，报告不推测对象关系。</p>`
    : `<div class="object-map">${cards}</div>`;
}

function integrations(options: ExportProductReportSiteOptions): string {
  const rows = new Map<string, { kinds: Set<string>; roots: Set<string>; facts: CitedFact[] }>();
  const facts = resolveSliceFacts(options.readers, projectTarget("product").scope, ["map-edge", "outbound-call", "notification-call"]);
  for (const fact of facts) {
    const value = asRecord(fact.value);
    const target = stringField(value, "target", "to", "channel", "baseIdentifier") ?? "目标在运行时确定";
    const row = rows.get(target) ?? { kinds: new Set<string>(), roots: new Set<string>(), facts: [] };
    row.kinds.add(fact.kind === "notification-call" ? "通知" : fact.kind === "outbound-call" ? "外部调用" : "项目边界");
    row.roots.add(fact.citation.rootName);
    row.facts.push(fact);
    rows.set(target, row);
  }
  if (rows.size === 0) return `<p class="callout unknown"><strong>未形成可引用的外部触点</strong>这不等于项目确认没有集成，只表示当前分析未取得可引用证据。</p>`;
  const body = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 30).map(([target, row]) => `<tr><td>${html(readableIdentifier(target))}</td><td>${html([...row.kinds].sort().join("、"))}</td><td>${html([...row.roots].sort().join(" · "))}</td></tr>`).join("");
  return `<table class="integration-table"><thead><tr><th>外部触点</th><th>源码可确认的关系</th><th>涉及源码根</th></tr></thead><tbody>${body}</tbody></table><p class="callout unknown"><strong>运行时边界</strong>静态源码可以确认配置和可达调用，但不能单独确认生产环境是否启用、账户是否有效或消息是否送达。</p>${evidence(facts, "查看集成证据", 20)}`;
}

function problemFacts(options: ExportProductReportSiteOptions, moduleId?: string): readonly CitedFact[] {
  const scope = moduleId === undefined ? projectTarget("product").scope : moduleScope(moduleId);
  const facts = resolveSliceFacts(options.readers, scope, ["feature-finding", "structural-finding", "health-signal", "diagnostic"]);
  const priority = (fact: CitedFact): number => {
    const value = asRecord(fact.value);
    const severity = stringField(value, "severity") ?? "";
    const id = stringField(value, "id", "problemId") ?? "";
    if (severity === "concern" || id === "rule-applied-two-ways") return 0;
    if (id === "failures-nobody-can-observe" || id === "endpoints-without-observed-auth") return 1;
    if (severity === "notice") return 2;
    return 3;
  };
  const genericFindingIds = new Set([
    "failures-nobody-can-observe",
    "rules-restated-in-many-places",
    "values-with-no-declared-meaning",
    "feature-without-observed-storage",
    "storage-observed-only-nearby",
  ]);
  const deduped = new Map<string, CitedFact>();
  for (const fact of [...facts].sort((a, b) => priority(a) - priority(b) || a.factId.localeCompare(b.factId))) {
    const value = asRecord(fact.value);
    const id = stringField(value, "id", "problemId") ?? "";
    if (genericFindingIds.has(id)) continue;
    const key = `${fact.kind}:${stringField(value, "id", "problemId", "title") ?? fact.factId}`;
    if (!deduped.has(key)) deduped.set(key, fact);
  }
  return [...deduped.values()].slice(0, moduleId === undefined ? 10 : 6);
}

function problemCopy(fact: CitedFact): { title: string; detail: string } {
  const value = asRecord(fact.value);
  const id = stringField(value, "id", "problemId") ?? "";
  const known: Readonly<Record<string, readonly [string, string]>> = {
    "rule-applied-two-ways": ["同一规则在不同路径中的边界不一致", "源码证据显示相关数值在不同路径使用了不同的比较边界，处于临界值时可能进入不同分支。"],
    "failures-nobody-can-observe": ["部分调用的失败结果未被保留", "这些调用没有把返回结果交给当前路径处理，因此失败可能不会被调用方观察或记录。"],
    "endpoints-without-observed-auth": ["部分入口未观察到边界鉴权", "这些入口没有声明分析器可识别的鉴权中间件；处理函数内部仍可能有检查，因此需要结合审查证据确认。"],
    "endpoints-without-resolved-handler": ["部分入口未能追踪到处理逻辑", "当前分析无法从这些入口继续定位处理函数，因此下游规则、数据影响和异常分支没有被完整描述。"],
    "endpoints-without-observed-caller": ["部分入口未在当前项目中找到调用方", "这些入口可能供项目外部使用，也可能已经不再使用；仅凭当前源码不能二选一。"],
    "values-with-no-declared-meaning": ["部分规则直接使用未命名数值", "这些比较值没有关联到可解释的状态或常量名称，跨路径核对其业务含义时存在证据缺口。"],
    "rules-restated-in-many-places": ["同一规则在多处重复实现", "相同的判断在多个源码位置分别出现，当前行为需要以所有实现共同核对。"],
    "feature-without-observed-storage": ["未建立入口到数据访问的关系", "当前分析没有为这些入口建立可归属的数据访问；这不表示功能确认不读写数据。"],
    "storage-observed-only-nearby": ["数据访问只在处理逻辑附近被观察到", "分析可以确认同一代码区域存在数据访问，但不能确认每个入口分别触及哪些数据。"],
  };
  const matched = known[id];
  if (matched !== undefined) return { title: matched[0], detail: matched[1] };
  return {
    title: stringField(value, "title", "subject", "category") ?? `${readableIdentifier(fact.kind)} 事项`,
    detail: stringField(value, "finding", "reason", "detail", "note", "impactBoundary") ?? "该记录由分析器形成，但没有额外的读者说明。",
  };
}

function problemRows(facts: readonly CitedFact[]): string {
  if (facts.length === 0) return `<p class="callout unknown"><strong>没有可归属的问题事实</strong>这表示当前切片未形成确认的问题记录，不代表运行环境已被证明没有问题。</p>`;
  return `<div class="issue-rows">${facts.slice(0, 30).map((fact, index) => {
    const value = asRecord(fact.value);
    const severity = (stringField(value, "severity", "confidence") ?? (["declared", "resolved"].includes(fact.resolutionClass) ? "源码确认" : "高置信推断")).toLowerCase();
    const copy = problemCopy(fact);
    const label = severity.includes("concern") || severity.includes("high") || severity.includes("error") ? "需要关注" : severity.includes("notice") ? "源码提示" : "待确认";
    return `<article class="issue-row"><div class="issue-meta"><span>${html(label)}</span><small>${html(stringField(value, "id", "problemId") ?? `F-${String(index + 1).padStart(2, "0")}`)}</small></div><div><h3>${html(copy.title)}</h3><p>${html(copy.detail)}</p>${evidence([fact])}</div></article>`;
  }).join("")}</div>`;
}

function reviewedIssueRows(
  issues: readonly StructuredIssue[],
  artifact: ProseArtifact | null,
): string {
  if (issues.length === 0 || artifact === null) return "";
  const byId = new Map(artifact.facts.map((fact) => [fact.factId, fact] as const));
  return `<div class="issue-rows reviewed-issues">${issues.map((issue, index) => {
    const facts = issue.factIds.map((id) => byId.get(id)).filter((fact): fact is CitedFact => fact !== undefined);
    const label = issue.status === "confirmed" ? "源码确认" : "需要确认";
    return `<article class="issue-row"><div class="issue-meta"><span>${label}</span><small>R-${String(index + 1).padStart(2, "0")}</small></div><div><h3>${html(issue.title)}</h3><p>${html(issue.observation)}</p><p class="issue-impact"><strong>影响边界：</strong>${html(issue.impact)}</p>${evidence(facts, "查看审查证据", 8)}</div></article>`;
  }).join("")}</div>`;
}

function combinedProblemRows(
  issues: readonly StructuredIssue[],
  artifact: ProseArtifact | null,
  deterministic: readonly CitedFact[],
): string {
  const reviewed = reviewedIssueRows(issues, artifact);
  const observed = deterministic.length === 0 ? "" : problemRows(deterministic);
  if (reviewed !== "" || observed !== "") return `${reviewed}${observed}`;
  return `<p class="callout unknown"><strong>当前切片没有形成可归属的问题</strong>这不代表运行环境已经被证明没有问题；覆盖限制仍在本页末尾单独披露。</p>`;
}

function coverage(options: ExportProductReportSiteOptions, moduleId?: string): string {
  if (moduleId !== undefined) {
    const kinds = ["module", "feature-flow", "condition", "guard", "business-rule", "state", "state-transition", "data-access", "outbound-call", "notification-call", "feature-finding"] as const;
    const labels: Readonly<Record<string, string>> = {
      module: "模块身份", "feature-flow": "业务流程", condition: "条件判断", guard: "拒绝与校验",
      "business-rule": "业务规则", state: "状态", "state-transition": "状态变化", "data-access": "数据影响",
      "outbound-call": "外部调用", "notification-call": "通知", "feature-finding": "问题记录",
    };
    const scope = moduleScope(moduleId);
    const rows = kinds.map((kind) => {
      const count = resolveSliceFacts(options.readers, scope, [kind]).length;
      return `<tr><td>${html(labels[kind] ?? readableIdentifier(kind))}</td><td class="${count > 0 ? "coverage-ok" : "coverage-limit"}">${count > 0 ? "有证据" : "未建立"}</td><td>${count} 条可归属事实；0 表示本次未建立，不解释为业务上不存在。</td></tr>`;
    }).join("");
    return `<table class="coverage-table"><thead><tr><th>核对层</th><th>状态</th><th>覆盖说明</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const context = options.kb.runContext();
  const rootCount = context?.roots.length ?? 0;
  const fileCount = context?.roots.reduce((sum, root) => sum + root.analyzed, 0) ?? options.kb.sourceFiles().length;
  const endpoints = options.kb.endpoints();
  const screens = options.kb.screens();
  const traces = options.kb.traces();
  const partial = traces.filter((trace) => trace.partial).length;
  const untraced = Math.max(0, endpoints.length - traces.length);
  const entities = options.kb.entities();
  const stats = `<div class="stat-grid coverage-stats"><div><strong>${rootCount}</strong><span>源码组成</span></div><div><strong>${fileCount}</strong><span>已分析文件</span></div><div><strong>${endpoints.length}</strong><span>后端入口</span></div><div><strong>${screens.length}</strong><span>界面入口</span></div><div><strong>${traces.length}</strong><span>已建立调用路径</span></div></div>`;
  const summaryRows = [
    ["源码清单", "有证据", `${rootCount} 个源码组成、${fileCount} 个已分析文件。`],
    ["用户与服务入口", "有证据", `${screens.length} 个界面入口、${endpoints.length} 个后端入口。`],
    ["端到端路径", untraced === 0 && partial === 0 ? "完整" : "部分覆盖", `${traces.length} 个入口已形成路径；${untraced} 个未形成路径，${partial} 个路径含未解析或截断部分。`],
    ["核心数据对象", entities.length > 0 ? "有证据" : "未建立", `${entities.length} 个数据对象具有结构或访问证据。`],
  ].map(([dimension, state, detail]) => `<tr><td>${html(dimension)}</td><td class="${state === "完整" || state === "有证据" ? "coverage-ok" : "coverage-limit"}">${html(state)}</td><td>${html(detail)}</td></tr>`).join("");
  const rows = options.kb.analysisDimensions().map((dimension) => {
    const state = !dimension.attempted ? "未执行" : dimension.records > 0 ? "有证据" : "已检查，未发现";
    const cls = dimension.attempted && dimension.records > 0 ? "coverage-ok" : "coverage-limit";
    const roots = dimension.byRoot.map((root) => `${root.rootName}: ${root.records}${root.reason === null ? "" : ` (${root.reason})`}`).join("；");
    return `<tr><td>${html(readableIdentifier(dimension.kind))}</td><td class="${cls}">${html(state)}</td><td>${dimension.records} 条记录。${html(roots)}</td></tr>`;
  }).join("");
  const notes = options.kb.coverageNotes();
  const limits = notes.length === 0
    ? ""
    : `<p class="callout unknown"><strong>存在明确的覆盖限制</strong>本次分析记录了 ${notes.length} 项未解析、能力边界或截断说明；它们没有被当作“确认不存在”。完整清单保留在下方技术明细中。</p>`;
  const detailNotes = notes.length === 0 ? "" : `<h4>覆盖限制原始记录</h4><ul>${notes.slice(0, 40).map((note) => `<li>${html(note.subject)}：${html(note.note)}</li>`).join("")}</ul>`;
  return `${stats}<table class="coverage-table"><thead><tr><th>核对层</th><th>状态</th><th>结论</th></tr></thead><tbody>${summaryRows}</tbody></table>${limits}<details class="coverage-details"><summary>查看技术分析维度与原始限制</summary><table class="coverage-table"><thead><tr><th>分析维度</th><th>状态</th><th>覆盖说明</th></tr></thead><tbody>${rows}</tbody></table>${detailNotes}</details>`;
}

function renderProjectPage(options: ExportProductReportSiteOptions, artifacts: ArtifactIndex, projectName: string, generatedDate: string): string {
  const documentId = targetKey(projectTarget("product"));
  const capabilitiesProse = artifacts.prose(documentId, "project-boundary.capabilities");
  const pathsProse = artifacts.prose(documentId, "project-roles-flows.paths");
  const rulesProse = artifacts.prose(documentId, "project-objects-lifecycle.rules");
  const issuesProse = artifacts.prose(documentId, "known-issues.impact");
  const issues = artifacts.structured(documentId, "known-issues.impact");
  const paths = artifacts.structured(documentId, "project-roles-flows.paths");
  const projectFacts = resolveSliceFacts(options.readers, projectTarget("product").scope, ["module", "feature", "route", "ui-label", "feature-flow"]);
  const flowFacts = resolveSliceFacts(options.readers, projectTarget("product").scope, ["feature-flow", "route", "condition", "ui-label"]);
  const run = options.kb.runContext();
  const lead = prosePlain(capabilitiesProse, run?.description ?? `${projectName} 的功能、业务路径、核心对象、外部触点和已知证据边界。`);
  const body = `<header class="hero" id="overview"><h1>${html(projectName)} 项目概览</h1><p class="hero-lead">${html(lead)}</p>${meta([
    ["报告范围", `${options.modules.length} 个功能模块`],
    ["阅读对象", "产品与非技术角色"],
    ["源码快照", generatedDate],
    ["表达原则", "事实 / 推断 / 未知分离"],
  ])}<div class="summary-strip"><p>项目概览覆盖全部已分类的产品模块；只为本次指定的 ${options.selectedModules.length} 个模块生成独立详情页。所有页面共用同一份分析快照和事实库。</p><a href="#capabilities">从功能地图开始 ↓</a></div></header>${section("capabilities", 1, "全部功能模块", "由代码入口、业务对象、关系和界面证据形成；外部服务与基础设施单独列示。", `${proseHtml(capabilitiesProse)}${capabilityMap(options)}${evidence(projectFacts, "查看模块分类证据", 20)}`)}${section("roles", 2, "角色与参与方式", "把数据库角色编码、权限检查和可读名称关联起来；未在当前源码中引用的角色不列入正文。", roleMap(options))}${section("structure", 3, "项目结构图", "从源码组成到业务能力、核心对象和外部触点的四层结构。", architecture(options))}${section("journeys", 4, "主要跨模块业务路径", "展示项目级端到端关系；模块内部的条件和分支在详情页展开。", `${proseHtml(pathsProse)}${projectJourneys(paths?.flowGroups ?? [], flowFacts)}`)}${section("objects", 5, "核心业务对象与规则", "按实际数据访问频率展示主要对象，生命周期与跨模块规则来自同一事实切片。", `${proseHtml(rulesProse)}${projectObjects(options)}`)}${section("integrations", 6, "通知、集成与数据影响", "外部系统是业务触点，不因为独立客户端或目录被误作产品模块。", integrations(options))}${section("problems", 7, "已知问题与待确认事项", "结构化源码审查与分析器问题记录分开展示；不添加优先级或整改建议。", combinedProblemRows(issues?.issues ?? [], issuesProse, problemFacts(options)))}${section("coverage", 8, "覆盖范围与源码快照", "区分有证据、已检查但未发现、未执行和无法由静态源码确认。", coverage(options))}${options.selectedModules.length === 0 ? "" : `<nav class="next-report"><a href="${pagePath(options.selectedModules[0]!)}"><span>开始阅读模块详情</span><strong>${html(options.selectedModules[0]!.displayName)} →</strong></a><a href="${pagePath(options.selectedModules.at(-1)!)}"><span>直接查看</span><strong>${html(options.selectedModules.at(-1)!.displayName)} →</strong></a></nav>`}`;
  return documentShell({
    options,
    projectName,
    generatedDate,
    current: "project",
    depth: 0,
    title: `${projectName} 项目概览`,
    sectionLinks: [["capabilities", "功能模块"], ["roles", "角色与参与方式"], ["structure", "项目结构"], ["journeys", "主要业务路径"], ["objects", "核心业务对象"], ["integrations", "通知与集成"], ["problems", "问题与未知"], ["coverage", "覆盖说明"]],
  }, body);
}

function factSummary(fact: CitedFact): { title: string; detail: string } {
  const value = asRecord(fact.value);
  switch (fact.kind) {
    case "route": {
      const path = stringField(value, "path") ?? "未解析入口";
      const method = stringField(value, "method") ?? (stringField(value, "surface") === "client" ? "页面" : "入口");
      return { title: `${method} ${path}`, detail: stringField(value, "handlerName") ?? "由此进入模块" };
    }
    case "ui-label":
    case "doc-comment":
      return { title: stringField(value, "text", "label") ?? readableIdentifier(fact.kind), detail: "源码中的界面文字或开发者说明" };
    case "state":
      return { title: stringField(value, "state", "name", "value") ?? "状态", detail: stringField(value, "entity", "subject") ?? "已观察到的业务状态" };
    case "state-transition":
      return { title: `${stringField(value, "from") ?? "未知起点"} → ${stringField(value, "to") ?? "未知终点"}`, detail: stringField(value, "trigger", "condition", "reason") ?? "状态变化" };
    case "value-set": {
      const members = arrayField(value, "members").map((member) => stringField(member, "name", "value") ?? "").filter(Boolean).slice(0, 8);
      return { title: stringField(value, "name") ?? "状态集合", detail: members.join(" · ") || "已命名的可选值" };
    }
    case "business-rule":
      return { title: stringField(value, "statement", "text", "subject") ?? "业务规则", detail: stringField(value, "fullTest", "guarded") ?? "源码中可解释的条件" };
    case "guard":
      return { title: stringField(value, "message", "test") ?? "校验规则", detail: stringField(value, "test") ?? "不满足时终止流程" };
    case "validation-rule":
      return { title: stringField(value, "rule", "field") ?? "字段校验", detail: stringField(value, "expression", "field") ?? "已声明的校验" };
    case "data-access":
      return { title: readableIdentifier(stringField(value, "entity") ?? "运行时数据对象"), detail: `${stringField(value, "operation") ?? "unknown"} · ${stringField(value, "mechanism") ?? "unknown"}` };
    case "outbound-call":
      return { title: readableIdentifier(stringField(value, "target", "baseIdentifier") ?? "运行时目标"), detail: `${stringField(value, "method", "kind") ?? "调用"}` };
    case "notification-call":
      return { title: `${stringField(value, "channel") ?? "未知渠道"} 通知`, detail: stringField(value, "mechanism", "call") ?? "发送位置已被识别" };
    case "feature-flow":
      return { title: stringField(value, "featureName", "name") ?? "业务流程", detail: stringField(value, "entryKey", "completion") ?? "从已识别入口开始" };
    default:
      return {
        title: stringField(value, "title", "name", "subject", "path", "id") ?? readableIdentifier(fact.kind),
        detail: stringField(value, "summary", "detail", "statement", "reason", "note") ?? "有可定位的分析事实",
      };
  }
}

function factRows(facts: readonly CitedFact[], cap = 28): string {
  if (facts.length === 0) return `<p class="callout unknown"><strong>没有可归属事实</strong>本次分析没有为该模块建立这一类证据，报告不解释为业务上确认不存在。</p>`;
  const rows = facts.slice(0, cap).map((fact) => {
    const summary = factSummary(fact);
    return `<div class="fact-row"><strong>${html(summary.title)}</strong><div><p>${html(summary.detail)}</p>${evidence([fact], "源码位置", 1)}</div></div>`;
  }).join("");
  const overflow = facts.length > cap ? `<p class="callout">还有 ${facts.length - cap} 条同类事实保留在事实库中；页面按稳定顺序展示前 ${cap} 条，覆盖核算仍使用完整数量。</p>` : "";
  return `<div class="fact-rows">${rows}</div>${overflow}`;
}

function moduleEntries(
  options: ExportProductReportSiteOptions,
  module: ReportModule,
  flowGroups: readonly StructuredFlowGroup[],
  lifecycles: readonly StructuredLifecycle[],
  lifecycleArtifact: ProseArtifact | null,
): string {
  const facts = resolveSliceFacts(options.readers, moduleScope(module.id), ["route", "auth-annotation", "ui-label"]);
  const routes = facts.filter((fact) => fact.kind === "route");
  const controls = facts.filter((fact) => fact.kind === "auth-annotation");
  const labels = unique(
    facts
      .filter((fact) => fact.kind === "ui-label")
      .map((fact) => stringField(fact.value, "text", "label") ?? ""),
    10,
  );
  const operations = unique(flowGroups.map((group) => group.title), 10);
  const cards = [
    {
      title: "可见业务操作",
      detail: operations.length === 0 ? "当前切片尚未形成可读的操作分组。" : operations.join("、"),
      note: `${routes.length} 个已识别入口`,
    },
    {
      title: "访问边界",
      detail: controls.length === 0
        ? "未观察到分析器可识别的身份或权限事实；不能据此推断入口公开。"
        : `在模块范围内观察到 ${controls.length} 条身份、角色或权限检查事实。`,
      note: "具体位置保留在折叠证据中",
    },
    {
      title: "界面与操作线索",
      detail: labels.length === 0 ? "当前切片没有形成可归属的界面文字。" : labels.join("、"),
      note: `${labels.length} 项代表性文字`,
    },
  ];
  return `<h3 class="minor-heading">参与角色与流程关系</h3>${roleMap(options, module.id, flowGroups, lifecycles, lifecycleArtifact)}<h3 class="minor-heading">入口与可见操作</h3><div class="object-map compact-map">${cards.map((card) => `<article><h3>${html(card.title)}</h3><p>${html(card.detail)}</p><small>${html(card.note)}</small></article>`).join("")}</div>${evidence(facts, "查看入口与访问边界证据", 18)}`;
}

function moduleRules(options: ExportProductReportSiteOptions, module: ReportModule): string {
  const facts = resolveSliceFacts(options.readers, moduleScope(module.id), ["state", "state-transition", "value-set", "business-rule", "guard", "validation-rule", "auth-annotation", "discarded-error"]);
  const count = (kinds: readonly string[]) => facts.filter((fact) => kinds.includes(fact.kind)).length;
  const stats = `<div class="stat-grid"><div><strong>${count(["state", "value-set"])}</strong><span>状态与值集合</span></div><div><strong>${count(["state-transition"])}</strong><span>状态变化</span></div><div><strong>${count(["business-rule", "guard", "validation-rule"])}</strong><span>规则与校验</span></div><div><strong>${count(["auth-annotation"])}</strong><span>访问控制事实</span></div></div>`;
  const meaningful = facts
    .filter((fact) => fact.scopeRole !== "supporting" && fact.kind !== "auth-annotation" && fact.kind !== "discarded-error")
    .slice(0, 18);
  const details = meaningful.length === 0
    ? ""
    : `<details class="coverage-details"><summary>查看代表性规则事实与源码位置</summary>${factRows(meaningful, 18)}</details>`;
  return `${stats}${details}${evidence(facts, "查看完整规则证据位置", 20)}`;
}

function moduleEffects(options: ExportProductReportSiteOptions, module: ReportModule): string {
  const facts = resolveSliceFacts(options.readers, moduleScope(module.id), ["outbound-call", "notification-call", "data-access"]);
  const counts = new Map<string, number>();
  for (const fact of facts) counts.set(fact.kind, (counts.get(fact.kind) ?? 0) + 1);
  const stats = `<div class="stat-grid"><div><strong>${counts.get("data-access") ?? 0}</strong><span>数据访问事实</span></div><div><strong>${counts.get("outbound-call") ?? 0}</strong><span>外部调用事实</span></div><div><strong>${counts.get("notification-call") ?? 0}</strong><span>通知事实</span></div><div><strong>${unique(facts.map((fact) => fact.citation.rootName)).length}</strong><span>涉及源码根</span></div></div>`;
  const ranked = (kind: string, fields: readonly string[], cap: number): readonly string[] => {
    const frequency = new Map<string, number>();
    for (const fact of facts.filter((entry) => entry.kind === kind)) {
      const name = stringField(fact.value, ...fields);
      if (name === null || /^(unknown|runtime|dynamic)$/i.test(name)) continue;
      frequency.set(name, (frequency.get(name) ?? 0) + 1);
    }
    return [...frequency.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, cap)
      .map(([name]) => readableIdentifier(name).replace(/^wcp\s+/i, ""));
  };
  const groups = [
    ["主要数据对象", ranked("data-access", ["entity"], 10)],
    ["调用与集成触点", ranked("outbound-call", ["target", "baseIdentifier"], 10)],
    ["通知方式", ranked("notification-call", ["channel", "mechanism", "call"], 8)],
  ] as const;
  const cards = `<div class="object-map compact-map">${groups.map(([title, names]) => `<article><h3>${html(title)}</h3><p>${html(names.length === 0 ? "当前分析未形成可命名的对象或触点。" : names.join("、"))}</p><small>${names.length} 项代表性结果</small></article>`).join("")}</div>`;
  return `${stats}${cards}${evidence(facts, "查看数据、调用与通知证据", 24)}`;
}

function renderModulePage(
  options: ExportProductReportSiteOptions,
  artifacts: ArtifactIndex,
  projectName: string,
  generatedDate: string,
  module: ReportModule,
  index: number,
): string {
  const documentId = targetKey(moduleTarget(module.id, "product"));
  const responsibility = artifacts.prose(documentId, "module-responsibility.summary");
  const flowProse = artifacts.prose(documentId, "module-flows-branches.flows");
  const lifecycleProse = artifacts.prose(documentId, "module-flows-branches.lifecycle");
  const rulesProse = artifacts.prose(documentId, "module-objects-rules-states.notes");
  const recoveryProse = artifacts.prose(documentId, "module-recovery.notes");
  const effectsProse = artifacts.prose(documentId, "module-notifications-data.notes");
  const issuesProse = artifacts.prose(documentId, "known-issues.impact");
  const issues = artifacts.structured(documentId, "known-issues.impact");
  const flows = artifacts.structured(documentId, "module-flows-branches.flows");
  const lifecycle = artifacts.structured(documentId, "module-flows-branches.lifecycle");
  const flowFacts = resolveSliceFacts(options.readers, moduleScope(module.id), ["feature-flow", "condition", "decision", "guard", "route", "ui-label"]);
  const membership = options.readers.memberships.get(module.id);
  const allFacts = resolveSliceFacts(options.readers, moduleScope(module.id), ["*"]);
  const lead = prosePlain(responsibility, module.summary);
  const sectionLinks: [string, string][] = [["responsibility", "模块职责"], ["entries", "角色与入口"], ["flows", "主要流程与分支"], ["lifecycle", "完整生命周期"], ["rules", "类型、状态与规则"]];
  if (recoveryProse !== null) sectionLinks.push(["recovery", "撤回与恢复"]);
  sectionLinks.push(["effects", "通知与数据"], ["problems", "问题与未知"], ["coverage", "覆盖说明"]);
  const recovery = recoveryProse === null ? "" : section("recovery", 6, "撤回、取消与恢复", "只描述当前源码可证明的回退、取消、重试或补偿行为。", proseHtml(recoveryProse));
  const effectsNumber = recoveryProse === null ? 6 : 7;
  const problemsNumber = effectsNumber + 1;
  const coverageNumber = problemsNumber + 1;
  const previous = options.selectedModules[index - 1];
  const next = options.selectedModules[index + 1];
  const nextNav = previous === undefined && next === undefined ? "" : `<nav class="next-report">${previous === undefined ? "<span></span>" : `<a href="../${pagePath(previous)}"><span>上一个模块</span><strong>← ${html(previous.displayName)}</strong></a>`}${next === undefined ? "<span></span>" : `<a href="../${pagePath(next)}"><span>下一个模块</span><strong>${html(next.displayName)} →</strong></a>`}</nav>`;
  const body = `<header class="hero" id="overview"><h1>${html(module.displayName)}</h1><p class="hero-lead">${html(lead)}</p>${meta([
    ["报告范围", "单一功能模块"],
    ["分析文件", `${membership?.fileCount ?? 0} 个`],
    ["事实总数", `${allFacts.length} 条`],
    ["源码快照", generatedDate],
  ])}<div class="summary-strip"><p>${html(module.summary)}</p><a href="#flows">查看主要流程 ↓</a></div></header>${section("responsibility", 1, "模块职责与边界", "说明该模块负责什么，以及它在项目功能地图中的位置。", proseHtml(responsibility))}${section("entries", 2, "角色、入口与可见操作", "角色来自项目角色定义和本模块权限检查；流程关系与可见操作分别列示。", moduleEntries(options, module, flows?.flowGroups ?? [], lifecycle?.lifecycles ?? [], lifecycleProse))}${section("flows", 3, "主要流程与分支条件", "复杂流程使用 Mermaid 展示分支；简单流程直接列出步骤，避免为少量节点增加阅读负担。", `${proseHtml(flowProse)}${flowLanes(flows?.flowGroups ?? [], flowFacts)}`)}${section("lifecycle", 4, "完整业务生命周期与变体", "从进入或创建开始，贯穿校验、提交、审批或处理、终止结果以及撤回和恢复；类型与阈值规则单独列明。", `${proseHtml(lifecycleProse)}${lifecycleAndVariants(lifecycle?.lifecycles ?? [], lifecycle?.variantGroups ?? [], lifecycleProse)}`)}${section("rules", 5, "对象、状态与业务规则", "保留源码中的状态名、校验、权限和异常边界；原始事实默认折叠。", `${proseHtml(rulesProse)}${moduleRules(options, module)}`)}${recovery}${section("effects", effectsNumber, "通知、外部调用与数据影响", "先说明业务影响，再提供可展开的源码证据；静态源码不证明生产环境实际启用。", `${proseHtml(effectsProse)}${moduleEffects(options, module)}`)}${section("problems", problemsNumber, "已知问题与待确认事项", "区分源码可直接确认的问题与需要更多上下文才能确认的关注点。", combinedProblemRows(issues?.issues ?? [], issuesProse, problemFacts(options, module.id)))}${section("coverage", coverageNumber, "覆盖范围与事实边界", "按事实类别核算；0 条表示当前分析未建立，不表示业务上确认不存在。", coverage(options, module.id))}${nextNav}`;
  return documentShell({ options, projectName, generatedDate, current: module.id, depth: 1, title: `${module.displayName} · ${projectName}`, sectionLinks }, body);
}

function safePreviousFiles(outDir: string): readonly string[] {
  const path = join(outDir, "manifest.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProductReportSiteManifest>;
    if (parsed.schemaVersion !== SITE_SCHEMA_VERSION || !Array.isArray(parsed.outputFiles)) return [];
    return parsed.outputFiles.filter((file) => typeof file === "string" && file !== "manifest.json" && !file.startsWith("/") && !file.split("/").includes(".."));
  } catch {
    return [];
  }
}

function writeGenerated(outDir: string, relativePath: string, content: string | Buffer): void {
  const path = join(outDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Export an already-prepared product report as a self-contained static site. */
export function exportProductReportSite(options: ExportProductReportSiteOptions): ProductReportSiteResult {
  const started = performance.now();
  if (!options.language.toLowerCase().startsWith("zh")) {
    throw new Error(`product-report-site.v1 currently supports Chinese only, got ${options.language}`);
  }
  if (!options.projectIncluded && options.selectedModules.length === 0) {
    throw new Error("a product report site needs a project report or at least one module report");
  }
  mkdirSync(options.outDir, { recursive: true });
  for (const file of safePreviousFiles(options.outDir)) {
    const path = join(options.outDir, file);
    if (existsSync(path)) unlinkSync(path);
  }

  const artifacts = artifactIndex(options);
  const run = options.kb.runContext();
  const projectName = run?.projectName?.trim() || basename(options.kb.snapshot.workspacePath) || "Project";
  const generatedDate = (run?.generatedAt ?? options.kb.snapshot.publishedAt).slice(0, 10);
  const files: string[] = [];
  if (options.projectIncluded) {
    writeGenerated(options.outDir, "index.html", renderProjectPage(options, artifacts, projectName, generatedDate));
    files.push("index.html");
  } else {
    const first = pagePath(options.selectedModules[0]!);
    writeGenerated(options.outDir, "index.html", `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${html(first)}"><title>${html(projectName)} 模块报告</title></head><body><p><a href="${html(first)}">打开模块报告</a></p></body></html>`);
    files.push("index.html");
  }
  options.selectedModules.forEach((module, index) => {
    const path = pagePath(module);
    writeGenerated(options.outDir, path, renderModulePage(options, artifacts, projectName, generatedDate, module, index));
    files.push(path);
  });
  writeGenerated(options.outDir, "assets/report.css", readFileSync(CSS_PATH));
  writeGenerated(options.outDir, "assets/report.js", readFileSync(JS_PATH));
  writeGenerated(options.outDir, "assets/mermaid.min.js", readFileSync(MERMAID_PATH));
  files.push("assets/report.css", "assets/report.js", "assets/mermaid.min.js");

  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const manifest: ProductReportSiteManifest = {
    schemaVersion: SITE_SCHEMA_VERSION,
    projectName,
    language: options.language,
    audience: "product",
    snapshotIdentity: options.kb.snapshot.identity,
    snapshotPublishedAt: options.kb.snapshot.publishedAt,
    projectIncluded: options.projectIncluded,
    productModuleCount: options.modules.length,
    selectedModules: options.selectedModules.map((module) => ({ id: module.id, displayName: module.displayName, file: pagePath(module) })),
    outputFiles: [...files, "metrics.json", "manifest.json"],
    metrics: { ...(options.metrics ?? {}), exportMs: elapsedMs },
  };
  writeGenerated(options.outDir, "metrics.json", `${JSON.stringify(manifest.metrics, null, 2)}\n`);
  files.push("metrics.json");
  writeGenerated(options.outDir, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  files.push("manifest.json");
  return { manifest, manifestPath: join(options.outDir, "manifest.json"), files, elapsedMs };
}

/** Paths are returned relative to the output root for portable manifests. */
export function productReportSiteFiles(result: ProductReportSiteResult, outDir: string): readonly string[] {
  return result.files.map((file) => relative(outDir, join(outDir, file)));
}
