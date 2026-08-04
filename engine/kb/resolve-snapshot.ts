/**
 * Which snapshot a reader reads.
 *
 * A knowledge base is append-only: one file can hold analyses of several
 * workspaces, several runs over one workspace, and snapshots left inert by runs
 * that failed before publishing. Every reader — the audit, `kb:query`,
 * `kb:readiness` — has to answer "which one" before it can answer anything
 * else, and answering it wrongly looks exactly like answering it rightly.
 *
 * This file used to be a thousand-line query facade over the whole base as
 * well, written for the report pipeline that composed documents from selectors.
 * The skill reads SQLite directly now, and the facade's last caller was a
 * baseline script nobody ran; what remains is the one question every reader
 * still asks.
 */

import type { Store } from "../store/types.js";

export class SnapshotNotFoundError extends Error {
  constructor(
    readonly runId: string | null,
    workspacePath?: string,
  ) {
    const where = workspacePath === undefined ? "" : ` for ${workspacePath}`;
    super(
      runId === null
        ? `No published analysis exists in this knowledge base${where}. Run \`analyze\` first.`
        : `No published analysis with run id ${runId}${where}. It may have failed before publishing.`,
    );
    this.name = "SnapshotNotFoundError";
  }
}

export class AmbiguousWorkspaceError extends Error {
  constructor(readonly workspacePaths: readonly string[]) {
    super(
      `This knowledge base holds analyses of ${workspacePaths.length} workspaces:\n` +
        workspacePaths.map((path) => `  ${path}`).join("\n") +
        "\nName one with --workspace, or a run with --run.",
    );
    this.name = "AmbiguousWorkspaceError";
  }
}

export interface Snapshot {
  readonly id: number;
  readonly runId: string | null;
  readonly identity: string;
  readonly publishedAt: string;
  readonly workspacePath: string;
}

interface SnapshotRow {
  readonly id: number;
  readonly run_id: string | null;
  readonly identity: string;
  readonly published_at: string;
  readonly path: string;
}

/**
 * The snapshot a query reads: the one named, or the latest published.
 *
 * Never an unpublished one. A run that failed partway leaves its snapshot
 * inert, and reading it would present half an analysis as the answer.
 *
 * With no run id and more than one workspace in the database, this refuses
 * rather than picking the most recent — one file can hold analyses of several
 * projects, and answering about the wrong one looks exactly like answering
 * about the right one.
 *
 * `id DESC` is the tie-break because `published_at` has millisecond resolution
 * and two runs in quick succession can share one.
 */
export function resolveSnapshot(store: Store, runId?: string, workspacePath?: string): Snapshot {
  if (runId === undefined && workspacePath === undefined) {
    const workspaces = store.all<{ path: string }>(
      `SELECT DISTINCT w.path FROM workspaces w
       JOIN snapshots s ON s.workspace_id = w.id
       WHERE s.published_at IS NOT NULL ORDER BY w.path`,
    );
    if (workspaces.length > 1) {
      throw new AmbiguousWorkspaceError(workspaces.map((row) => row.path));
    }
  }

  const clause = runId !== undefined ? "s.run_id = ?" : workspacePath !== undefined ? "w.path = ?" : "1 = 1";
  const params = runId ?? workspacePath;

  const row = store.get<SnapshotRow>(
    `SELECT s.id, s.run_id, s.identity, s.published_at, w.path
     FROM snapshots s JOIN workspaces w ON w.id = s.workspace_id
     WHERE ${clause} AND s.published_at IS NOT NULL
     ORDER BY s.published_at DESC, s.id DESC LIMIT 1`,
    params === undefined ? [] : [params],
  );

  if (row === undefined) throw new SnapshotNotFoundError(runId ?? null, workspacePath);
  return {
    id: row.id,
    runId: row.run_id,
    identity: row.identity,
    publishedAt: row.published_at,
    workspacePath: row.path,
  };
}

/**
 * What a capability produced, so an empty answer can be read correctly.
 *
 * A query returning nothing means one of two things, and the difference is the
 * whole point: this project has none, or nothing in this run could look. Every
 * selector that can come back empty is paired with one of these.
 */
