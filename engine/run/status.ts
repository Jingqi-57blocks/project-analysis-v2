import type { Store } from "../store/types.js";
import type { StatusProviderCheck, StatusReport, StatusRoot } from "./types.js";

interface WorkspaceRow {
  readonly id: number;
}

interface SnapshotRow {
  readonly id: number;
  readonly identity: string;
  readonly published_at: string;
}

interface SourceRootRow {
  readonly id: number;
  readonly name: string;
  readonly vcs: string | null;
  readonly commit_sha: string | null;
  readonly branch: string | null;
  readonly dirty: number | null;
}

interface DispositionCountRow {
  readonly disposition: string;
  readonly n: number;
}

interface ProviderCheckRow {
  readonly provider_id: string;
  readonly version: string | null;
  readonly available: number;
  readonly reason: string | null;
  readonly checked_at: string;
}

/**
 * Reports the latest published state of a workspace's knowledge base.
 *
 * A workspace never analyzed, and one with only an orphaned unpublished
 * snapshot from a run that failed before publishing, are the same reportable
 * state — `analyzed: false` — not an error. Absence is a first-class state
 * here, the same principle used for target resolution throughout this
 * project.
 */
export function getStatus(store: Store, workspacePath: string): StatusReport {
  const workspace = store.get<WorkspaceRow>("SELECT id FROM workspaces WHERE path = ?", [workspacePath]);
  if (!workspace) return { workspacePath, analyzed: false };

  // `id DESC` is the tie-break: `published_at` has millisecond resolution, so
  // two runs in quick succession can share one. SQLite happens to return the
  // higher id today by walking the snapshots_workspace index in reverse, but
  // that is a property of the current query plan, not of the query — an added
  // index or a changed schema could flip it silently. Stating the tie-break
  // makes "latest" mean the same thing regardless of how it gets executed.
  const snapshot = store.get<SnapshotRow>(
    `SELECT id, identity, published_at FROM snapshots
     WHERE workspace_id = ? AND published_at IS NOT NULL
     ORDER BY published_at DESC, id DESC LIMIT 1`,
    [workspace.id],
  );
  if (!snapshot) return { workspacePath, analyzed: false };

  const sourceRoots = store.all<SourceRootRow>(
    "SELECT id, name, vcs, commit_sha, branch, dirty FROM source_roots WHERE snapshot_id = ? ORDER BY name",
    [snapshot.id],
  );

  const roots: StatusRoot[] = sourceRoots.map((root) => {
    const counts = store.all<DispositionCountRow>(
      "SELECT disposition, COUNT(*) AS n FROM files WHERE source_root_id = ? GROUP BY disposition",
      [root.id],
    );
    return {
      name: root.name,
      vcs: root.vcs,
      commitSha: root.commit_sha,
      branch: root.branch,
      dirty: root.dirty === null ? null : root.dirty === 1,
      counts: counts.map((c) => ({ disposition: c.disposition, count: c.n })),
    };
  });

  const providerChecks: StatusProviderCheck[] = store
    .all<ProviderCheckRow>(
      `SELECT provider_id, version, available, reason, checked_at FROM provider_checks
       WHERE snapshot_id = ? ORDER BY provider_id`,
      [snapshot.id],
    )
    .map((row) => ({
      providerId: row.provider_id,
      version: row.version,
      available: row.available === 1,
      reason: row.reason,
      checkedAt: row.checked_at,
    }));

  return {
    workspacePath,
    analyzed: true,
    snapshotId: snapshot.id,
    identity: snapshot.identity,
    publishedAt: snapshot.published_at,
    roots,
    providerChecks,
  };
}
