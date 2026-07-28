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
