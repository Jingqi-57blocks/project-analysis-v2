import type { Migration } from "./types.js";

/**
 * Append-only schema history.
 *
 * Never edit an applied migration — add another. A shipped database has already
 * run the old text, so changing it makes the schema depend on which version of
 * the tool happened to create it.
 *
 * These are the base tables only: workspace identity, snapshots, roots and
 * files. Domain entities belong to the knowledge-base layer and arrive later.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "base-tables",
    up: `
      CREATE TABLE workspaces (
        id          INTEGER PRIMARY KEY,
        path        TEXT    NOT NULL UNIQUE,
        created_at  TEXT    NOT NULL
      );

      -- One analysis run over one coherent source state. A run is only visible
      -- once published_at is set, so a failed run cannot be mistaken for a
      -- successful smaller one.
      CREATE TABLE snapshots (
        id            INTEGER PRIMARY KEY,
        workspace_id  INTEGER NOT NULL REFERENCES workspaces(id),
        identity      TEXT    NOT NULL,
        created_at    TEXT    NOT NULL,
        published_at  TEXT
      );
      CREATE INDEX snapshots_workspace ON snapshots(workspace_id, published_at);

      -- Version control is supplementary: content_digest is the identity and is
      -- always present, commit_sha and friends only when the root has git.
      CREATE TABLE source_roots (
        id              INTEGER PRIMARY KEY,
        snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
        name            TEXT    NOT NULL,
        path            TEXT    NOT NULL,
        content_digest  TEXT    NOT NULL,
        vcs             TEXT,
        commit_sha      TEXT,
        branch          TEXT,
        dirty           INTEGER,
        UNIQUE (snapshot_id, name)
      );

      -- Exactly one disposition per file. Anything not analyzed carries a
      -- reason, so "discovered = analyzed + excluded + unsupported + failed"
      -- can be asserted rather than hoped for.
      CREATE TABLE files (
        id              INTEGER PRIMARY KEY,
        source_root_id  INTEGER NOT NULL REFERENCES source_roots(id),
        rel_path        TEXT    NOT NULL,
        size_bytes      INTEGER NOT NULL,
        disposition     TEXT    NOT NULL
                        CHECK (disposition IN ('analyzed','excluded','unsupported','failed')),
        classification  TEXT,
        reason          TEXT,
        UNIQUE (source_root_id, rel_path)
      );
      CREATE INDEX files_disposition ON files(source_root_id, disposition);

      -- Cost is recorded from the first run. Metrics added after something is
      -- slow measure the wrong things.
      CREATE TABLE phase_metrics (
        id           INTEGER PRIMARY KEY,
        snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id),
        phase        TEXT    NOT NULL,
        duration_ms  INTEGER NOT NULL,
        items        INTEGER,
        bytes        INTEGER
      );
    `,
  },
];

export const SUPPORTED_SCHEMA_VERSION: number =
  MIGRATIONS.length === 0 ? 0 : Math.max(...MIGRATIONS.map((m) => m.version));
