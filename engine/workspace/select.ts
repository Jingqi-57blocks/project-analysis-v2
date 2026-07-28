import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { asRoot, classifyDirectory, discoverRoots } from "./discover.js";
import {
  WorkspaceSelectionError,
  type DiscoveredRoot,
  type Selection,
  type SelectedRoot,
  type SkippedEntry,
} from "./types.js";

export interface SelectOptions {
  /** One container, one root, or an explicit list of roots. */
  readonly paths: readonly string[];
  /** Keep only these root names. */
  readonly include?: readonly string[];
  /** Drop these root names. */
  readonly exclude?: readonly string[];
}

function requireDirectory(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new WorkspaceSelectionError(`Path does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new WorkspaceSelectionError(`Not a directory: ${resolved}`);
  }
  return resolved;
}

interface Discovery {
  readonly workspacePath: string;
  readonly mode: Selection["mode"];
  readonly modeReason: string;
  readonly roots: readonly DiscoveredRoot[];
  readonly skipped: readonly SkippedEntry[];
}

function discover(paths: readonly string[]): Discovery {
  if (paths.length === 0) {
    throw new WorkspaceSelectionError("No paths given.");
  }

  if (paths.length > 1) {
    const roots = paths.map((p) => asRoot(requireDirectory(p)));
    return {
      workspacePath: resolve(paths[0]!, ".."),
      mode: "explicit",
      modeReason: `${roots.length} paths given explicitly`,
      roots,
      skipped: [],
    };
  }

  const path = requireDirectory(paths[0]!);
  const verdict = classifyDirectory(path);

  if (verdict.isRoot) {
    return {
      workspacePath: path,
      mode: "single-root",
      modeReason: `${path} ${verdict.reason}, so it is analyzed as one root`,
      roots: [asRoot(path)],
      skipped: [],
    };
  }

  const { roots, skipped } = discoverRoots(path);
  if (roots.length === 0) {
    throw new WorkspaceSelectionError(
      `${path} ${verdict.reason}, but contains no candidate roots either. ` +
        "Point at a project directory, or pass its roots explicitly.",
    );
  }

  return {
    workspacePath: path,
    mode: "parent",
    modeReason: `${path} ${verdict.reason}`,
    roots,
    skipped,
  };
}

function applySelection(
  roots: readonly DiscoveredRoot[],
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): readonly SelectedRoot[] {
  const names = new Set(roots.map((r) => r.name));

  for (const name of [...(include ?? []), ...(exclude ?? [])]) {
    if (!names.has(name)) {
      throw new WorkspaceSelectionError(
        `No root named "${name}". Discovered: ${[...names].join(", ")}`,
      );
    }
  }

  const includeSet = include && include.length > 0 ? new Set(include) : null;
  const excludeSet = new Set(exclude ?? []);

  return roots.map((root) => {
    if (excludeSet.has(root.name)) {
      return { ...root, selected: false, excludedReason: "excluded by request" };
    }
    if (includeSet && !includeSet.has(root.name)) {
      return { ...root, selected: false, excludedReason: "not in the requested subset" };
    }
    return { ...root, selected: true };
  });
}

/**
 * Resolves what the user pointed at into a set of source roots.
 *
 * Both what was found and what was selected are returned, because a report that
 * silently describes a subset reads as describing the whole. Callers persist the
 * full picture, not just the roots they read.
 */
export function selectWorkspace(options: SelectOptions): Selection {
  const discovery = discover(options.paths);
  const roots = applySelection(discovery.roots, options.include, options.exclude);

  if (!roots.some((r) => r.selected)) {
    throw new WorkspaceSelectionError(
      "Selection left no roots to analyze. " +
        `Discovered: ${discovery.roots.map((r) => r.name).join(", ")}`,
    );
  }

  return {
    workspacePath: discovery.workspacePath,
    mode: discovery.mode,
    modeReason: discovery.modeReason,
    roots,
    skipped: discovery.skipped,
  };
}
