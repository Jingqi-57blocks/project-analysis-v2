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
  {
    version: 2,
    name: "provider-checks",
    up: `
      -- Run metadata, not analysis content — the same category as
      -- phase_metrics, not the knowledge-base layer's domain entities.
      -- Recorded per snapshot rather than globally: a provider's
      -- availability and version can change between runs (installed,
      -- upgraded, removed), and reproducibility depends on knowing which
      -- state was true for a given knowledge base.
      CREATE TABLE provider_checks (
        id            INTEGER PRIMARY KEY,
        snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id),
        provider_id   TEXT    NOT NULL,
        version       TEXT,
        available     INTEGER NOT NULL,
        reason        TEXT,
        checked_at    TEXT    NOT NULL
      );
      CREATE INDEX provider_checks_snapshot ON provider_checks(snapshot_id);
    `,
  },
  {
    version: 3,
    name: "structural-model",
    up: `
      -- One row per distinct structural fact. The model has many kinds and
      -- would otherwise need many near-identical tables; a kind column plus a
      -- JSON payload keeps the schema small while the denormalized columns
      -- below keep the common queries indexable. Provider-specific shapes
      -- never reach this table — everything is already normalized to the
      -- model by the time it arrives.
      CREATE TABLE structural_records (
        id                INTEGER PRIMARY KEY,
        snapshot_id       INTEGER NOT NULL REFERENCES snapshots(id),
        source_root_id    INTEGER NOT NULL REFERENCES source_roots(id),
        kind              TEXT    NOT NULL,
        -- Deterministic identity, so two providers finding the same fact
        -- converge on one row instead of double-counting it.
        record_key        TEXT    NOT NULL,
        payload           TEXT    NOT NULL,
        resolution_class  TEXT    NOT NULL
                          CHECK (resolution_class IN ('declared','resolved','inferred','unresolved')),
        confidence        TEXT,
        -- Denormalized from provenance so "what is in this file" does not
        -- require parsing every payload.
        rel_path          TEXT,
        start_line        INTEGER,
        UNIQUE (snapshot_id, kind, record_key)
      );
      CREATE INDEX structural_records_kind ON structural_records(snapshot_id, kind);
      CREATE INDEX structural_records_root ON structural_records(source_root_id, kind);
      CREATE INDEX structural_records_path ON structural_records(source_root_id, rel_path);

      -- Many-to-one on purpose: when two providers supply the same fact it
      -- becomes one record with both attributions, never one record whose
      -- second source was discarded.
      CREATE TABLE structural_attributions (
        id                INTEGER PRIMARY KEY,
        record_id         INTEGER NOT NULL REFERENCES structural_records(id),
        provider_id       TEXT    NOT NULL,
        provider_version  TEXT    NOT NULL,
        UNIQUE (record_id, provider_id, provider_version)
      );

      -- Retained, never resolved. Two providers disagreeing about the same
      -- fact is information; silently picking a winner would produce reports
      -- that are confidently wrong, which is worse than reports that say the
      -- sources disagree.
      CREATE TABLE structural_conflicts (
        id            INTEGER PRIMARY KEY,
        record_id     INTEGER NOT NULL REFERENCES structural_records(id),
        provider_id   TEXT    NOT NULL,
        field         TEXT    NOT NULL,
        value         TEXT,
        UNIQUE (record_id, provider_id, field)
      );

      -- What each capability actually produced, per provider per root. A
      -- capability with no row here was never asked, which is a different
      -- state from one that was asked and supplied nothing — conflating them
      -- would let a silent gap read as a confident finding of emptiness.
      CREATE TABLE capability_results (
        id                INTEGER PRIMARY KEY,
        snapshot_id       INTEGER NOT NULL REFERENCES snapshots(id),
        source_root_id    INTEGER NOT NULL REFERENCES source_roots(id),
        provider_id       TEXT    NOT NULL,
        provider_version  TEXT    NOT NULL,
        kind              TEXT    NOT NULL,
        language          TEXT    NOT NULL,
        outcome           TEXT    NOT NULL CHECK (outcome IN ('supplied','partial','absent')),
        reason            TEXT,
        record_count      INTEGER NOT NULL,
        UNIQUE (snapshot_id, source_root_id, provider_id, kind, language)
      );
      CREATE INDEX capability_results_snapshot ON capability_results(snapshot_id, kind);

      -- One provider failing on one file degrades only that capability. The
      -- same per-item isolation already proven for one unreadable file in the
      -- inventory walker and one broken provider in preflight.
      CREATE TABLE extraction_failures (
        id              INTEGER PRIMARY KEY,
        snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
        source_root_id  INTEGER NOT NULL REFERENCES source_roots(id),
        provider_id     TEXT    NOT NULL,
        scope           TEXT    NOT NULL,
        reason          TEXT    NOT NULL
      );
      CREATE INDEX extraction_failures_snapshot ON extraction_failures(snapshot_id);
    `,
  },
  {
    version: 4,
    name: "semantic-evidence",
    up: `
      -- Text developers already wrote, stored as written. A summary derived
      -- from it can always be produced again; the original cannot be
      -- recovered once discarded, so the raw text is what is kept.
      --
      -- Keyed by source rather than by module: modules do not exist at this
      -- stage, and binding evidence to them would make it unusable for any
      -- template querying by another axis.
      CREATE TABLE evidence_items (
        id                INTEGER PRIMARY KEY,
        snapshot_id       INTEGER NOT NULL REFERENCES snapshots(id),
        source_root_id    INTEGER NOT NULL REFERENCES source_roots(id),
        kind              TEXT    NOT NULL,
        item_key          TEXT    NOT NULL,
        text              TEXT    NOT NULL,
        label             TEXT,
        -- Null whenever no structural model was available. Semantic collection
        -- must never require one.
        symbol_id         TEXT,
        rel_path          TEXT    NOT NULL,
        start_line        INTEGER,
        start_column      INTEGER,
        resolution_class  TEXT    NOT NULL
                          CHECK (resolution_class IN ('declared','resolved','inferred','unresolved')),
        confidence        TEXT,
        UNIQUE (snapshot_id, item_key)
      );
      CREATE INDEX evidence_items_kind ON evidence_items(snapshot_id, kind);
      CREATE INDEX evidence_items_path ON evidence_items(source_root_id, rel_path);

      CREATE TABLE evidence_attributions (
        id                 INTEGER PRIMARY KEY,
        item_id            INTEGER NOT NULL REFERENCES evidence_items(id),
        collector_id       TEXT    NOT NULL,
        collector_version  TEXT    NOT NULL,
        UNIQUE (item_id, collector_id, collector_version)
      );

      -- Where two collectors disagree about the same text, both survive.
      -- Silently preferring one is a claim this stage cannot support.
      CREATE TABLE evidence_conflicts (
        id            INTEGER PRIMARY KEY,
        item_id       INTEGER NOT NULL REFERENCES evidence_items(id),
        collector_id  TEXT    NOT NULL,
        text          TEXT    NOT NULL,
        UNIQUE (item_id, collector_id)
      );

      CREATE TABLE evidence_gaps (
        id              INTEGER PRIMARY KEY,
        snapshot_id     INTEGER NOT NULL REFERENCES snapshots(id),
        source_root_id  INTEGER NOT NULL REFERENCES source_roots(id),
        collector_id    TEXT    NOT NULL,
        kind            TEXT    NOT NULL,
        language        TEXT    NOT NULL,
        reason          TEXT    NOT NULL
      );
      CREATE INDEX evidence_gaps_snapshot ON evidence_gaps(snapshot_id);
    `,
  },
];

export const SUPPORTED_SCHEMA_VERSION: number =
  MIGRATIONS.length === 0 ? 0 : Math.max(...MIGRATIONS.map((m) => m.version));
