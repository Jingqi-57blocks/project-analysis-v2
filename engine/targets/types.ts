/** Whether a target's roots are under version control. */
export type Vcs = "git" | "none";

/**
 * A real project the engine is developed and graded against.
 *
 * Targets are never vendored into this repository — only described. A target
 * that is absent from disk is an expected state, not an error.
 */
export interface TargetDefinition {
  readonly id: string;
  /** Default location. `~` is expanded against the user's home directory. */
  readonly defaultPath: string;
  /** Roots expected directly under the target path. */
  readonly roots: readonly string[];
  readonly vcs: Vcs;
  /** Why this target is in the registry — which coverage it supplies. */
  readonly covers: string;
}

export interface ResolvedRoot {
  readonly name: string;
  readonly path: string;
  readonly present: boolean;
  /** True when this root has its own `.git` directory. */
  readonly isGitRepo: boolean;
}

export interface ResolvedTarget {
  readonly id: string;
  readonly path: string;
  readonly vcs: Vcs;
  readonly roots: readonly ResolvedRoot[];
  /** Declared roots that are not on disk. Empty when the target is intact. */
  readonly missingRoots: readonly string[];
}

export interface TargetUnavailable {
  readonly id: string;
  /** Human-readable, and actionable — names the env var that overrides the path. */
  readonly reason: string;
}

export type TargetResolution =
  | { readonly ok: true; readonly target: ResolvedTarget }
  | { readonly ok: false; readonly unavailable: TargetUnavailable };
