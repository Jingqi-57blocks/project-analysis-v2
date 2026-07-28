import { openSync, readSync, closeSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";

import { classifyPath, looksGenerated, DEPENDENCY_DIRECTORIES, type Classification } from "./classify.js";

const DEPENDENCY_DIR_REASON = "dependency-manager-owned directory, not walked";
const VCS_DIR_REASON = "version-control internals, not walked";
const NOISE_FILE_REASON = "OS/editor metadata file";

/**
 * Directories excluded wholesale for a reason other than being
 * dependency-manager output — version-control internals, not project content.
 *
 * Deliberately not reusing `engine/targets/digest.ts`'s `IGNORED_ENTRIES`:
 * that set is designed to be *silently* skipped, which is correct for
 * computing a content digest but is exactly the silent-omission failure this
 * module exists to prevent. Every directory pruned here still gets its own
 * excluded row with a reason — nothing here disappears without a trace.
 */
const VCS_DIRECTORIES: ReadonlySet<string> = new Set([".git"]);

/** Noise files with no project-content meaning, excluded individually with a reason. */
const NOISE_FILENAMES: ReadonlySet<string> = new Set([".DS_Store"]);

export interface AnalyzedFile {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly classification: Classification;
}

/** A file or whole subtree excluded before analysis, with why. */
export interface ExcludedEntry {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly reason: string;
}

export interface FailedFile {
  readonly relPath: string;
  readonly reason: string;
}

export interface WalkResult {
  readonly analyzed: readonly AnalyzedFile[];
  readonly excluded: readonly ExcludedEntry[];
  readonly failed: readonly FailedFile[];
}

const GENERATED_PEEK_BYTES = 512;

/** Reads a bounded prefix of a file without loading the whole thing. */
function readPrefix(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/** Total bytes of every regular file under `dir`, without reading any content. */
function subtreeSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += subtreeSize(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        // Unreadable entries inside an already-excluded subtree do not need
        // their own failure record — the whole subtree is one excluded row.
      }
    }
  }
  return total;
}

function classifyFile(absPath: string, relPath: string): Classification {
  const byPath = classifyPath(relPath);

  // Every classification except "source" is trusted as final — strong,
  // specific evidence (a test naming convention, a known config filename, a
  // migrations directory) is unlikely to be overridden by a generated-file
  // marker in a way that matters. "source" is provisional: real generated code
  // almost always keeps its language's ordinary extension, so a .go/.ts/etc.
  // file gets one more chance to reveal itself as generated before this
  // settles on "source". Confirmed against a real file, not a guess:
  // wcp-auth/docs/docs.go is a plain .go file whose content says otherwise.
  if (byPath !== null && byPath !== "source") return byPath;

  try {
    if (looksGenerated(readPrefix(absPath, GENERATED_PEEK_BYTES))) return "generated";
  } catch {
    // Peeking failed (permissions, race with deletion). The file is still
    // present and stat'd, so fall through to whatever classifyPath already
    // found rather than failing the whole file over one unreadable signal.
  }

  return byPath ?? "unknown";
}

/**
 * Walks one root and gives every file exactly one disposition's worth of
 * evidence: analyzed with a classification, excluded as a whole subtree or
 * individual noise file (with a reason), or failed with a reason.
 *
 * Read-only: only reads directory listings, file stats, and a bounded prefix
 * of files needed for classification. Never writes anything.
 */
export function walkRoot(rootPath: string): WalkResult {
  const analyzed: AnalyzedFile[] = [];
  const excluded: ExcludedEntry[] = [];
  const failed: FailedFile[] = [];

  function excludeSubtree(full: string, relPath: string, reason: string): void {
    excluded.push({ relPath, sizeBytes: subtreeSize(full), reason });
  }

  function visit(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      failed.push({ relPath: relative(rootPath, dir), reason: describeError(error) });
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const relPath = relative(rootPath, full);

      if (entry.isDirectory()) {
        if (DEPENDENCY_DIRECTORIES.has(entry.name)) {
          excludeSubtree(full, relPath, DEPENDENCY_DIR_REASON);
          continue;
        }
        if (VCS_DIRECTORIES.has(entry.name)) {
          excludeSubtree(full, relPath, VCS_DIR_REASON);
          continue;
        }
        visit(full);
        continue;
      }

      if (!entry.isFile()) continue;

      if (NOISE_FILENAMES.has(entry.name)) {
        try {
          excluded.push({ relPath, sizeBytes: statSync(full).size, reason: NOISE_FILE_REASON });
        } catch (error) {
          failed.push({ relPath, reason: describeError(error) });
        }
        continue;
      }

      try {
        const sizeBytes = statSync(full).size;
        analyzed.push({ relPath, sizeBytes, classification: classifyFile(full, relPath) });
      } catch (error) {
        failed.push({ relPath, reason: describeError(error) });
      }
    }
  }

  visit(rootPath);

  return { analyzed, excluded, failed };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
