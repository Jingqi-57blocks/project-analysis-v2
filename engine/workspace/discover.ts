import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, extname, join } from "node:path";

import { MANIFEST_FILENAMES, NON_ROOT_DIRECTORIES, SOURCE_EXTENSIONS } from "./manifests.js";
import type { DiscoveredRoot, SkippedEntry } from "./types.js";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function hasManifest(dir: string): boolean {
  return MANIFEST_FILENAMES.some((name) => existsSync(join(dir, name)));
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** True when the directory holds source files directly, not only in subfolders. */
function hasTopLevelSource(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()),
    );
  } catch {
    return false;
  }
}

/** True when any file exists anywhere beneath the directory. */
export function isEmptyTree(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) return false;
    if (entry.isDirectory() && !NON_ROOT_DIRECTORIES.has(entry.name)) {
      if (!isEmptyTree(join(dir, entry.name))) return false;
    }
  }
  return true;
}

export interface RootVerdict {
  readonly isRoot: boolean;
  readonly reason: string;
}

/**
 * Decides whether a directory is a source root in its own right, as opposed to
 * a folder that *contains* source roots.
 *
 * This distinction is the one that matters: get it wrong on a single project
 * and its internal packages are analyzed as if they were separate services.
 * Evidence is taken in order of how much it settles the question.
 */
export function classifyDirectory(dir: string): RootVerdict {
  if (isGitRepo(dir)) {
    return { isRoot: true, reason: "has its own .git directory" };
  }
  if (hasManifest(dir)) {
    return { isRoot: true, reason: "declares a manifest" };
  }
  if (hasTopLevelSource(dir)) {
    return { isRoot: true, reason: "contains source files directly" };
  }
  return {
    isRoot: false,
    reason: "no .git, manifest, or top-level source files — treated as a container of roots",
  };
}

export interface DiscoveryResult {
  readonly roots: readonly DiscoveredRoot[];
  readonly skipped: readonly SkippedEntry[];
}

function describeRoot(name: string, path: string): DiscoveredRoot {
  return {
    name,
    path,
    hasManifest: hasManifest(path),
    isGitRepo: isGitRepo(path),
    isEmpty: isEmptyTree(path),
  };
}

/** Describes one directory as a root, without asking whether it contains others. */
export function asRoot(path: string): DiscoveredRoot {
  return describeRoot(basename(path), path);
}

/**
 * Finds candidate roots directly beneath a container.
 *
 * Only immediate children are considered. Recursing would turn every package of
 * a monorepo into a root, which is a different question than "what projects is
 * the user pointing at".
 */
export function discoverRoots(container: string): DiscoveryResult {
  const roots: DiscoveredRoot[] = [];
  const skipped: SkippedEntry[] = [];

  for (const entry of readdirSync(container, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;

    if (entry.name.startsWith(".")) {
      skipped.push({ name: entry.name, reason: "hidden directory" });
      continue;
    }
    if (NON_ROOT_DIRECTORIES.has(entry.name)) {
      skipped.push({ name: entry.name, reason: "dependency, build output, or tooling state" });
      continue;
    }

    const path = join(container, entry.name);
    if (!isDirectory(path)) continue;

    roots.push(describeRoot(entry.name, path));
  }

  return { roots, skipped };
}
