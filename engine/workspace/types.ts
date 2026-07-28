/** How the set of roots was arrived at. Recorded so the decision is inspectable. */
export type SelectionMode = "explicit" | "single-root" | "parent";

export interface DiscoveredRoot {
  readonly name: string;
  readonly path: string;
  readonly hasManifest: boolean;
  readonly isGitRepo: boolean;
  /** No files anywhere beneath it. Recorded rather than silently dropped. */
  readonly isEmpty: boolean;
}

export interface SelectedRoot extends DiscoveredRoot {
  readonly selected: boolean;
  /** Why this root was not selected. Absent when it was. */
  readonly excludedReason?: string;
}

export interface SkippedEntry {
  readonly name: string;
  readonly reason: string;
}

export interface Selection {
  readonly workspacePath: string;
  readonly mode: SelectionMode;
  /** Why this mode was chosen — the heuristic's reasoning, in words. */
  readonly modeReason: string;
  /** Every root considered, selected or not. */
  readonly roots: readonly SelectedRoot[];
  /** Directories never treated as candidate roots, each with a reason. */
  readonly skipped: readonly SkippedEntry[];
}

export class WorkspaceSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSelectionError";
  }
}

/** The roots an analysis will actually read. */
export function analyzedRoots(selection: Selection): readonly SelectedRoot[] {
  return selection.roots.filter((r) => r.selected);
}
