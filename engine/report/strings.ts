/**
 * Report wording, per language.
 *
 * Language changes the wording and never the finding. Identifiers, paths,
 * route paths and evidence quoted from source stay verbatim in every language
 * — translating a function name would break the link between a report and the
 * code it describes, which is the one property that makes a report checkable.
 *
 * An unknown language falls back to English rather than emitting a
 * half-translated report.
 */

import { DEFAULT_LANGUAGE, type OutputLanguage } from "./model.js";

export interface ReportStrings {
  readonly overview: string;
  readonly modules: string;
  readonly components: string;
  readonly integrations: string;
  readonly health: string;
  readonly coverage: string;
  readonly contents: string;
  readonly generated: string;
  readonly run: string;
  readonly project: string;
  readonly roots: string;
  readonly files: string;
  readonly entryPoints: string;
  readonly partOf: string;
  readonly evidence: string;
  readonly noModules: string;
  readonly noComponents: string;
  readonly noIntegrations: string;
  readonly whatWeCouldNotSee: string;
  readonly severityInfo: string;
  readonly severityNotice: string;
  readonly severityConcern: string;
  readonly dispositionTitle: string;
  readonly behavioural: string;
  readonly sharedInfrastructure: string;
  readonly technicalOnly: string;
  readonly unclassified: string;
  readonly serves: string;
  readonly calls: string;
  readonly projectMap: string;
  readonly whatItIs: string;
  readonly dataTouched: string;
  readonly callsOutward: string;
  readonly external: string;
  readonly datastore: string;
  readonly noAttention: string;
  readonly noEvidence: string;
  readonly noRoutes: string;
  readonly moduleCount: string;
  readonly entities: string;
  readonly endpoint: string;
  readonly mapCaveat: string;
  readonly descriptionFrom: string;
  readonly features: string;
  readonly services: string;
  readonly featuresIntro: string;
  readonly featuresNone: string;
  readonly featureShape: string;
  readonly featureEndpoints: string;
  readonly featureData: string;
  readonly featureFlows: string;
  readonly featureFlowsComplete: string;
  readonly featureNoFlows: string;
  readonly featuresUnassigned: (count: number) => string;
  readonly featureFlowsShown: (shown: number, total: number) => string;
  readonly featureFlowsPartial: (partial: number, total: number) => string;
  readonly languageFallback: string | null;
}

const EN: ReportStrings = {
  overview: "Overview",
  modules: "Features",
  components: "Technical components",
  integrations: "How the parts talk to each other",
  health: "What to look at",
  coverage: "What this report cannot tell you",
  contents: "Contents",
  generated: "Generated",
  run: "Run",
  project: "Project",
  roots: "Parts of the codebase",
  files: "files",
  entryPoints: "Entry points",
  partOf: "Spans",
  evidence: "What the code says about it",
  noModules: "No features could be formed from the entry points found.",
  noComponents: "No technical components were identified.",
  noIntegrations: "No calls between parts of the codebase were resolved.",
  whatWeCouldNotSee: "Every limitation below is a known gap, not a guess.",
  severityInfo: "For information",
  severityNotice: "Worth noting",
  severityConcern: "Worth attention",
  dispositionTitle: "Where the code sits",
  behavioural: "Serves a feature",
  sharedInfrastructure: "Shared infrastructure",
  technicalOnly: "Technical only",
  unclassified: "Not classified",
  serves: "Serves",
  calls: "calls",
  projectMap: "How the system fits together",
  whatItIs: "What this is",
  dataTouched: "Data it works with",
  callsOutward: "What it calls",
  external: "outside this workspace",
  datastore: "data store",
  noAttention: "Nothing was found that needs attention.",
  noEvidence: "The code carries no description of this area.",
  noRoutes: "No entry points were resolved for this feature.",
  moduleCount: "features",
  entities: "data entities",
  endpoint: "Endpoint",
  mapCaveat:
    "External destinations are read from URLs written in source. A URL in configuration or documentation can appear here even where no call is made, so treat this as what the code mentions rather than a verified list of live traffic.",
  descriptionFrom: "Taken from",
  features: "Features",
  services: "Services",
  featuresIntro:
    "What the product does, grouped by the words the team already uses for it. A feature can span several services.",
  featuresNone: "No feature could be identified from the vocabulary in this workspace.",
  featureShape: "At a glance",
  featureEndpoints: "Endpoints",
  featureData: "Data it touches",
  featureFlows: "Flows",
  featureFlowsComplete: "End to end",
  featureNoFlows: "No flow could be assembled for this feature's endpoints.",
  featuresUnassigned: (count: number) =>
    `${count} endpoints name no feature and appear only under their service.`,
  featureFlowsShown: (shown: number, total: number) => `${shown} of ${total} flows are shown here.`,
  featureFlowsPartial: (partial: number, total: number) =>
    `${partial} of ${total} have at least one hop that could not be established.`,
  languageFallback: null,
};

const ZH: ReportStrings = {
  overview: "总览",
  modules: "功能模块",
  components: "技术组件",
  integrations: "各部分之间的调用",
  health: "需要关注的地方",
  coverage: "本报告无法说明的部分",
  contents: "目录",
  generated: "生成时间",
  run: "运行编号",
  project: "项目",
  roots: "代码组成",
  files: "个文件",
  entryPoints: "入口",
  partOf: "涉及",
  evidence: "代码中的相关描述",
  noModules: "未能从已发现的入口归纳出功能模块。",
  noComponents: "未识别出技术组件。",
  noIntegrations: "未解析出各部分之间的调用关系。",
  whatWeCouldNotSee: "以下每一项都是已知的缺口，而非推测。",
  severityInfo: "参考信息",
  severityNotice: "值得留意",
  severityConcern: "建议关注",
  dispositionTitle: "代码分布",
  behavioural: "服务于功能",
  sharedInfrastructure: "共享基础设施",
  technicalOnly: "纯技术代码",
  unclassified: "未归类",
  serves: "服务于",
  calls: "次调用",
  projectMap: "系统结构",
  whatItIs: "这是什么",
  dataTouched: "涉及的数据",
  callsOutward: "对外调用",
  external: "工作区之外",
  datastore: "数据存储",
  noAttention: "未发现需要关注的问题。",
  noEvidence: "代码中没有关于该部分的描述。",
  noRoutes: "未解析出该功能的入口。",
  moduleCount: "个功能模块",
  entities: "个数据实体",
  endpoint: "接口",
  mapCaveat:
    "外部依赖来自源码中出现的 URL。配置或文档中的 URL 也可能出现在此处，即使并未真正发起调用，因此应将其视为代码中提及的内容，而非已验证的实际流量。",
  descriptionFrom: "摘自",
  features: "功能模块",
  services: "服务",
  featuresIntro: "产品实际提供的能力，按团队自己使用的术语归类。一个功能可能横跨多个服务。",
  featuresNone: "未能从该工作区的词汇中识别出功能模块。",
  featureShape: "整体概览",
  featureEndpoints: "接口",
  featureData: "涉及的数据",
  featureFlows: "流程",
  featureFlowsComplete: "完整链路",
  featureNoFlows: "该功能的接口未能组装出完整流程。",
  featuresUnassigned: (count: number) => `有 ${count} 个接口未归入任何功能，仅在其所属服务下列出。`,
  featureFlowsShown: (shown: number, total: number) => `共 ${total} 条流程，此处展示 ${shown} 条。`,
  featureFlowsPartial: (partial: number, total: number) =>
    `其中 ${partial} 条（共 ${total} 条）存在无法确认的环节。`,
  languageFallback: null,
};

const TABLES: Readonly<Record<string, ReportStrings>> = { en: EN, zh: ZH };

export function stringsFor(language: OutputLanguage): ReportStrings {
  const table = TABLES[language];
  if (table) return table;

  // Says so rather than silently emitting English under a foreign label.
  return {
    ...EN,
    languageFallback: `No wording is available for "${language}"; this report is in English.`,
  };
}

export function supportedLanguages(): readonly string[] {
  return Object.keys(TABLES).sort();
}

export { DEFAULT_LANGUAGE };
