export type {
  OutputLanguage, ReportRootSummary, ReportModule, ReportComponent,
  ReportIntegration, CoverageNote, ReportModel, AssembleReportInput,
} from "./model.js";
export { assembleReport, DEFAULT_LANGUAGE } from "./model.js";
export type { ReportStrings } from "./strings.js";
export { stringsFor, supportedLanguages } from "./strings.js";
export type { RenderedPage } from "./html.js";
export { renderHtmlReport, escapeHtml } from "./html.js";
export type { GenerateOptions, GenerateResult } from "./generate.js";
export { generateReport } from "./generate.js";
