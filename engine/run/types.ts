import type { Provider, PreflightReport } from "../providers/types.js";
import type { InventoryCounts } from "../inventory/persist.js";

export interface AnalyzeOptions {
  /** One container, one root, or an explicit list of roots — see `selectWorkspace`. */
  readonly paths: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Where the knowledge base lives. Never inside an analyzed target. */
  readonly dbPath: string;
  readonly providers?: readonly Provider[];
  /** Overrides the generated run id. For tests and for resuming a named run. */
  readonly runId?: string;
  /** Provider ids that must be available. Missing ones refuse the run before publish. */
  readonly requiredProviderIds?: readonly string[];
}

export interface AnalyzedRootResult {
  readonly name: string;
  readonly vcs: "git" | "none";
  readonly commitSha: string | null;
  readonly dirty: boolean | null;
  readonly counts: InventoryCounts;
}

export interface AnalysisResult {
  readonly snapshotId: number;
  /** Identity of this invocation — the key later reports bind themselves to. */
  readonly runId: string;
  /** Content digest of the source. Two runs of unchanged source share it. */
  readonly identity: string;
  readonly workspacePath: string;
  readonly roots: readonly AnalyzedRootResult[];
  readonly providerReport: PreflightReport;
}

/** One phase's cost. `items`/`bytes` are omitted, never forced, when a phase has no natural volume. */
export interface PhaseMetric {
  readonly phase: string;
  readonly durationMs: number;
  readonly items?: number;
  readonly bytes?: number;
}

export interface StatusRoot {
  readonly name: string;
  readonly vcs: string | null;
  readonly commitSha: string | null;
  readonly branch: string | null;
  readonly dirty: boolean | null;
  readonly counts: readonly { readonly disposition: string; readonly count: number }[];
}

export interface StatusProviderCheck {
  readonly providerId: string;
  readonly version: string | null;
  readonly available: boolean;
  readonly reason: string | null;
  readonly checkedAt: string;
}

/**
 * `analyzed: false` covers two absences on purpose: a workspace path never
 * seen before, and one with only an orphaned unpublished snapshot from a run
 * that failed before publishing. Both are the same reportable state — nothing
 * usable exists yet — not an error.
 */
export interface StatusReport {
  readonly workspacePath: string;
  readonly analyzed: boolean;
  readonly snapshotId?: number;
  readonly runId?: string | null;
  readonly identity?: string;
  readonly publishedAt?: string;
  readonly roots?: readonly StatusRoot[];
  readonly providerChecks?: readonly StatusProviderCheck[];
}
