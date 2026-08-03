/**
 * The report contract's identity and version. PI-70 fixes the target/combination
 * vocabulary; PI-71 extends it with the section catalog and document presets;
 * PI-108 adds the self-describing output specs and the shared writing contract;
 * 1.2.0 makes diagrams Mermaid rather than hand-written SVG; 2.0.0 restores an
 * `inferred` tier, so a report may say what a system does rather than only what
 * it contains.
 */

export const REPORT_CONTRACT_ID = "report";

/** Semantic version of the report contract. */
export const REPORT_CONTRACT_VERSION = "2.0.0";
