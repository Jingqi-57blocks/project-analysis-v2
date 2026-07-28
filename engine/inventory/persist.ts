import type { Store } from "../store/types.js";
import type { WalkResult } from "./walk.js";

export interface InventoryCounts {
  readonly discovered: number;
  readonly analyzed: number;
  readonly excluded: number;
  /** No current signal produces this — kept honest at zero rather than force-fit. */
  readonly unsupported: number;
  readonly failed: number;
}

/**
 * Writes one `files` row per analyzed file, one per excluded dependency
 * directory, and one per failed file, then returns counts derived from the
 * exact rows just written.
 *
 * The accounting invariant — discovered = analyzed + excluded + unsupported +
 * failed — holds by construction here: every count comes from the same
 * `WalkResult` this function persists, so there is no path that could produce
 * a mismatch. That is the point: it is not merely tested, it is structurally
 * unable to disagree with itself.
 */
export function recordInventory(
  store: Store,
  sourceRootId: number,
  result: WalkResult,
): InventoryCounts {
  return store.transaction(() => {
    for (const file of result.analyzed) {
      store.run(
        `INSERT INTO files (source_root_id, rel_path, size_bytes, disposition, classification, reason)
         VALUES (?, ?, ?, 'analyzed', ?, NULL)`,
        [sourceRootId, file.relPath, file.sizeBytes, file.classification],
      );
    }

    for (const entry of result.excluded) {
      store.run(
        `INSERT INTO files (source_root_id, rel_path, size_bytes, disposition, classification, reason)
         VALUES (?, ?, ?, 'excluded', NULL, ?)`,
        [sourceRootId, entry.relPath, entry.sizeBytes, entry.reason],
      );
    }

    for (const file of result.failed) {
      store.run(
        `INSERT INTO files (source_root_id, rel_path, size_bytes, disposition, classification, reason)
         VALUES (?, ?, 0, 'failed', NULL, ?)`,
        [sourceRootId, file.relPath, file.reason],
      );
    }

    const analyzed = result.analyzed.length;
    const excluded = result.excluded.length;
    const failed = result.failed.length;
    const unsupported = 0;

    return { discovered: analyzed + excluded + unsupported + failed, analyzed, excluded, unsupported, failed };
  });
}
