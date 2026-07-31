/**
 * The report contract: what a caller may ask for and how one analysis serves
 * many documents, independent of how any of them is rendered.
 *
 * PI-70 owns ReportTarget (Scope × Audience), request legality, module-only
 * semantics and analysis-snapshot reuse. PI-71 adds the shared section catalog
 * and the four fixed document presets.
 */

export * from "./target.js";
export * from "./snapshot.js";
export * from "./blocks.js";
export * from "./catalog.js";
export * from "./presets.js";
export * from "./version.js";
