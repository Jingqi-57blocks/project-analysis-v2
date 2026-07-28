import type { Store } from "../store/types.js";
import { checkDrift } from "./drift.js";
import { workspaceIdentity } from "./identity.js";
import type { RootSnapshot } from "./rootsnapshot.js";

export interface PersistedRoot {
  readonly name: string;
  readonly id: number;
}

export interface SnapshotHandle {
  readonly workspaceId: number;
  readonly snapshotId: number;
  readonly identity: string;
  /** Row ids for the roots just persisted — inventory attaches `files` rows to these. */
  readonly roots: readonly PersistedRoot[];
}

export class DriftDetectedError extends Error {
  constructor(readonly changedRoots: readonly string[]) {
    super(
      `Source changed during analysis in: ${changedRoots.join(", ")}. ` +
        "Refusing to publish — a knowledge base built from an inconsistent " +
        "source state would describe a codebase that never existed. Re-run once the source is stable.",
    );
    this.name = "DriftDetectedError";
  }
}

interface WorkspaceRow {
  readonly id: number;
}

function upsertWorkspace(store: Store, path: string, now: string): number {
  store.run("INSERT OR IGNORE INTO workspaces (path, created_at) VALUES (?, ?)", [path, now]);
  const row = store.get<WorkspaceRow>("SELECT id FROM workspaces WHERE path = ?", [path]);
  if (!row) {
    // Unreachable except under concurrent-write races the store layer does not
    // yet guard against; fail loudly rather than return an invalid handle.
    throw new Error(`Failed to create or find workspace row for ${path}`);
  }
  return row.id;
}

/**
 * Begins a snapshot: records the workspace and every root's captured identity
 * in one transaction, but leaves the snapshot unpublished.
 *
 * An unpublished snapshot is not yet a valid basis for anything downstream —
 * `publishOrRefuse` is what makes it visible, and only after confirming the
 * source has not moved since these roots were captured.
 */
export function beginSnapshot(
  store: Store,
  workspacePath: string,
  roots: readonly RootSnapshot[],
  now: string = new Date().toISOString(),
): SnapshotHandle {
  const identity = workspaceIdentity(roots);

  return store.transaction(() => {
    const workspaceId = upsertWorkspace(store, workspacePath, now);

    store.run(
      "INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (?, ?, ?, NULL)",
      [workspaceId, identity, now],
    );
    const snapshotRow = store.get<{ id: number }>(
      "SELECT id FROM snapshots WHERE workspace_id = ? AND identity = ? AND created_at = ?",
      [workspaceId, identity, now],
    );
    if (!snapshotRow) throw new Error("Failed to read back the snapshot row just inserted");

    const persistedRoots: PersistedRoot[] = [];
    for (const root of roots) {
      store.run(
        `INSERT INTO source_roots
           (snapshot_id, name, path, content_digest, vcs, commit_sha, branch, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshotRow.id,
          root.name,
          root.path,
          root.contentDigest,
          root.vcs,
          root.commitSha,
          root.branch,
          root.dirty === null ? null : root.dirty ? 1 : 0,
        ],
      );
      const rootRow = store.get<{ id: number }>(
        "SELECT id FROM source_roots WHERE snapshot_id = ? AND name = ?",
        [snapshotRow.id, root.name],
      );
      if (!rootRow) throw new Error(`Failed to read back the source_roots row for ${root.name}`);
      persistedRoots.push({ name: root.name, id: rootRow.id });
    }

    return { workspaceId, snapshotId: snapshotRow.id, identity, roots: persistedRoots };
  });
}

/**
 * Confirms no analyzed root changed since it was captured, then publishes.
 *
 * On drift, throws `DriftDetectedError` and leaves `published_at` unset — the
 * snapshot row stays on disk but inert, since callers query only published
 * snapshots. Cleaning up or surfacing orphaned unpublished rows is left to
 * later status/maintenance work.
 */
export function publishOrRefuse(
  store: Store,
  handle: SnapshotHandle,
  roots: readonly RootSnapshot[],
  now: string = new Date().toISOString(),
): void {
  const drift = checkDrift(roots);
  if (!drift.ok) {
    throw new DriftDetectedError(drift.changedRoots);
  }

  store.run("UPDATE snapshots SET published_at = ? WHERE id = ?", [now, handle.snapshotId]);
}
