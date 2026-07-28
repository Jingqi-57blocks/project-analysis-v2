import { digestDirectory } from "../targets/digest.js";
import type { RootSnapshot } from "./rootsnapshot.js";

export interface DriftCheck {
  readonly ok: boolean;
  /** Root names whose content digest no longer matches what was recorded. */
  readonly changedRoots: readonly string[];
}

/**
 * Re-digests every root and compares against what was captured earlier.
 *
 * Called once analysis has finished reading source, immediately before
 * publish. A knowledge base built from source that changed partway through the
 * run would describe a codebase that never existed at any single moment —
 * worse than producing nothing, since it looks authoritative. The cost is one
 * re-hash of files already read.
 */
export function checkDrift(before: readonly RootSnapshot[]): DriftCheck {
  const changedRoots = before
    .filter((root) => digestDirectory(root.path) !== root.contentDigest)
    .map((root) => root.name);

  return { ok: changedRoots.length === 0, changedRoots };
}
