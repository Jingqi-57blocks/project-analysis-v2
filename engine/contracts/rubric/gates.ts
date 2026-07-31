/**
 * The acceptance gates and their thresholds.
 *
 * Each gate names its input artifact, formula, thresholds, failure code and
 * owner, so a pass is objective and recomputable — never "the artifact exists"
 * or "the agent judged it usable". The golden-slice thresholds are fixed as
 * release-blocking here so no downstream implementation can quietly relax them.
 */

export type Milestone = "M1" | "M2" | "M3" | "M4" | "M5" | "M6";
export type Comparator = ">=" | "<=" | "==";

export interface GateThreshold {
  readonly metric: string;
  readonly comparator: Comparator;
  readonly value: number;
}

export function meetsThreshold(threshold: GateThreshold, actual: number): boolean {
  switch (threshold.comparator) {
    case ">=":
      return actual >= threshold.value;
    case "<=":
      return actual <= threshold.value;
    case "==":
      return actual === threshold.value;
  }
}

export interface GateDefinition {
  readonly id: string;
  readonly milestone: Milestone;
  /** golden-slice | all-targets | generalization */
  readonly appliesTo: string;
  readonly inputArtifact: string;
  readonly formula: string;
  readonly thresholds: readonly GateThreshold[];
  readonly failureCode: string;
  readonly owner: string;
}

export interface GateResult {
  readonly gateId: string;
  readonly passed: boolean;
  readonly failures: readonly { readonly threshold: GateThreshold; readonly actual: number }[];
}

/** Recomputable evaluation: a missing or unmet metric fails, deterministically. */
export function evaluateGate(gate: GateDefinition, metrics: Readonly<Record<string, number>>): GateResult {
  const failures = gate.thresholds
    .filter((t) => !(t.metric in metrics) || !meetsThreshold(t, metrics[t.metric] as number))
    .map((t) => ({ threshold: t, actual: t.metric in metrics ? (metrics[t.metric] as number) : Number.NaN }));
  return { gateId: gate.id, passed: failures.length === 0, failures };
}

/**
 * V1's release-blocking golden-slice thresholds (WCP-V2 leave). Fixed here, not
 * left to implementation: 100% of must-find found and must-print printed, no
 * critical unresolved/unsupported/failed/truncated, no known-wrong, no silent
 * omission, and the required CodeGraph lane available.
 */
export const GOLDEN_SLICE_THRESHOLDS: readonly GateThreshold[] = [
  { metric: "must_find_ratio", comparator: "==", value: 1 },
  { metric: "must_print_ratio", comparator: "==", value: 1 },
  { metric: "critical_unresolved", comparator: "==", value: 0 },
  { metric: "critical_unsupported", comparator: "==", value: 0 },
  { metric: "critical_failed", comparator: "==", value: 0 },
  { metric: "critical_truncated", comparator: "==", value: 0 },
  { metric: "known_wrong", comparator: "==", value: 0 },
  { metric: "silent_omission", comparator: "==", value: 0 },
  { metric: "required_codegraph_lane_available", comparator: "==", value: 1 },
];

/** Denominators the report-combination and dedup gates account against. */
export const COMBINATION_DENOMINATORS: readonly string[] = [
  "requested_target",
  "generated_document",
  "section",
  "deterministic_block",
  "authored_block",
  "execution_bundle",
  "slice_key",
  "slice_materialization",
  "block_attempt",
  "adopted_attempt",
];

/** Invariants the M3/M6 combination gates reject, named for machine reference. */
export const DEDUP_RULES: readonly string[] = [
  "no unrequested document is generated (no plan/task/artifact; not counted as omitted)",
  "each provider executes at most once per analysisRunId",
  "each sliceKey is materialized at most once",
  "module-only never secretly generates a project-level document",
  "shared-claim identity does not drift across documents",
  "a required authored block missing/failed/over-budget blocks completion",
];

export const GATES: readonly GateDefinition[] = [
  {
    id: "M1-structure-golden",
    milestone: "M1",
    appliesTo: "golden-slice",
    inputArtifact: "structural truth gate over the WCP-V2 leave slice",
    formula: "found(structural must-find) / total(structural must-find)",
    thresholds: [
      { metric: "must_find_ratio", comparator: "==", value: 1 },
      { metric: "critical_unresolved", comparator: "==", value: 0 },
      { metric: "required_codegraph_lane_available", comparator: "==", value: 1 },
    ],
    failureCode: "M1_STRUCTURE_GOLDEN_FAIL",
    owner: "PI-65",
  },
  {
    id: "M1-smoke-noreader",
    milestone: "M1",
    appliesTo: "generalization",
    inputArtifact: "no-route-reader backend smoke gate",
    formula: "useful_structure_produced ? 1 : 0",
    thresholds: [{ metric: "useful_structure", comparator: "==", value: 1 }],
    failureCode: "M1_NOREADER_SMOKE_FAIL",
    owner: "PI-66",
  },
  {
    id: "M2-behavior-golden",
    milestone: "M2",
    appliesTo: "golden-slice",
    inputArtifact: "behavior truth gate over the leave slice",
    formula: "found(behavior must-find) / total(behavior must-find)",
    thresholds: [
      { metric: "must_find_ratio", comparator: "==", value: 1 },
      { metric: "critical_unresolved", comparator: "==", value: 0 },
    ],
    failureCode: "M2_BEHAVIOR_GOLDEN_FAIL",
    owner: "PI-67",
  },
  {
    id: "M3-report-golden",
    milestone: "M3",
    appliesTo: "golden-slice",
    inputArtifact: "report/citation/accounting gate over the leave module documents",
    formula: "printed(must-print) / total(must-print) within required scope x audience",
    thresholds: [
      { metric: "must_print_ratio", comparator: "==", value: 1 },
      { metric: "slice_out_claims", comparator: "==", value: 0 },
    ],
    failureCode: "M3_REPORT_GOLDEN_FAIL",
    owner: "PI-68",
  },
  {
    id: "M3-dedup",
    milestone: "M3",
    appliesTo: "all-targets",
    inputArtifact: "combination/dedup accounting for a ReportRequest",
    formula: "provider executions and slice materializations per analysisRunId",
    thresholds: [
      { metric: "duplicate_provider_executions", comparator: "==", value: 0 },
      { metric: "duplicate_slice_materializations", comparator: "==", value: 0 },
      { metric: "unrequested_documents", comparator: "==", value: 0 },
    ],
    failureCode: "M3_DEDUP_FAIL",
    owner: "PI-73",
  },
  {
    id: "M4-fresh-run-golden",
    milestone: "M4",
    appliesTo: "golden-slice",
    inputArtifact: "fresh module-only run of the leave slice at the frozen snapshot",
    formula: "all golden-slice thresholds on a fresh run",
    thresholds: GOLDEN_SLICE_THRESHOLDS,
    failureCode: "M4_GOLDEN_FAIL",
    owner: "PI-19",
  },
  {
    id: "M5-generalization",
    milestone: "M5",
    appliesTo: "generalization",
    inputArtifact: "angels-pizza + no-reader sentinel accounting",
    formula: "sentinel found/wrong/missing/clean-absence tally",
    thresholds: [
      { metric: "sentinel_precision_errors", comparator: "==", value: 0 },
      { metric: "sentinel_wrong_empty", comparator: "==", value: 0 },
    ],
    failureCode: "M5_GENERALIZATION_FAIL",
    owner: "PI-25",
  },
  {
    id: "M6-release",
    milestone: "M6",
    appliesTo: "golden-slice",
    inputArtifact: "release audit over a fresh run at feat HEAD",
    formula: "all golden-slice thresholds + accounting balance + citation truth",
    thresholds: [
      ...GOLDEN_SLICE_THRESHOLDS,
      { metric: "accounting_imbalance", comparator: "==", value: 0 },
    ],
    failureCode: "M6_RELEASE_FAIL",
    owner: "PI-33",
  },
];

export function gatesForMilestone(milestone: Milestone): readonly GateDefinition[] {
  return GATES.filter((g) => g.milestone === milestone);
}
