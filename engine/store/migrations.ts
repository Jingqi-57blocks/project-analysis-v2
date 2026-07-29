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

      -- Where collectors disagree about the same text, every reading survives.
      -- Silently preferring one is a claim this stage cannot support.
      --
      -- The text is part of the uniqueness key, not just the collector: one
      -- collector can legitimately produce several divergent readings for one
      -- item, and keying on the collector alone would keep only the last.
      CREATE TABLE evidence_conflicts (
        id            INTEGER PRIMARY KEY,
        item_id       INTEGER NOT NULL REFERENCES evidence_items(id),
        collector_id  TEXT    NOT NULL,
        text          TEXT    NOT NULL,
        UNIQUE (item_id, collector_id, text)
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
  {
    version: 5,
    name: "run-identity",
    up: `
      -- Identity of an invocation, as distinct from identity of what was
      -- analyzed. \`identity\` is a content digest, so two runs over unchanged
      -- source share it — which is what makes drift detection work, and what
      -- makes it useless for telling runs apart.
      --
      -- Runs need telling apart: a user analyzes the same project repeatedly,
      -- and an overview and a module report generated separately must be
      -- recognizable as belonging to the same run rather than being mixed
      -- across two.
      --
      -- Added as a nullable column with a unique index rather than NOT NULL,
      -- because SQLite cannot add a NOT NULL column to an existing table
      -- without a default, and any default here would be a lie. Snapshots
      -- written before this migration keep a null run id, which is honest:
      -- they predate the concept.
      ALTER TABLE snapshots ADD COLUMN run_id TEXT;
      CREATE UNIQUE INDEX snapshots_run_id ON snapshots(run_id);
    `,
  },
  {
    version: 6,
    name: "derived-facts",
    up: `
      -- What the analysis worked out, as opposed to what a provider read.
      --
      -- A route is extracted; a feature is concluded. Both are facts with
      -- locations and both must be queryable, but they arrive by different
      -- routes and carry different guarantees, so they live in different
      -- tables rather than sharing one and losing the distinction.
      --
      -- Same shape as structural_records for the same reasons: one kind
      -- column and a JSON payload instead of fifteen near-identical tables,
      -- with the columns that get filtered on lifted out so a query does not
      -- have to parse every payload to answer "what is wrong with this
      -- feature" or "what did this file contribute".
      --
      -- What must never be stored here is a view. No rendered tables, no
      -- assembled sentences, no counts that a query could compute. Diagram
      -- sources are the one exception and they are stored deliberately: the
      -- shape of a flow is a fact, and a template embeds that string rather
      -- than composing it. Everything else is recomputed at render time,
      -- which is what makes a report nobody has designed yet possible.
      CREATE TABLE derived_records (
        id            INTEGER PRIMARY KEY,
        snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id),
        kind          TEXT    NOT NULL,
        record_key    TEXT    NOT NULL,
        payload       TEXT    NOT NULL,
        -- The thing this is about: a feature id, a module id, an entity name.
        -- Null where the fact is about the workspace as a whole.
        subject_key   TEXT,
        root_name     TEXT,
        severity      TEXT,
        rel_path      TEXT,
        start_line    INTEGER,
        UNIQUE (snapshot_id, kind, record_key)
      );
      CREATE INDEX derived_records_kind ON derived_records(snapshot_id, kind);
      CREATE INDEX derived_records_subject ON derived_records(snapshot_id, kind, subject_key);
      CREATE INDEX derived_records_severity ON derived_records(snapshot_id, severity);

      -- Ownership between facts, which is many-to-many in every direction
      -- that matters: a feature owns flows and rules, a module spans
      -- features, a flow reaches entities several other flows also reach.
      -- A column on the payload could hold one of those and would quietly
      -- lose the rest.
      --
      -- Deliberately not foreign-keyed to either side. The far end is often
      -- a structural record — a feature's endpoints are routes — and
      -- requiring one table for both ends would mean copying extracted facts
      -- into the derived table to point at them.
      CREATE TABLE derived_links (
        id           INTEGER PRIMARY KEY,
        snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id),
        from_kind    TEXT    NOT NULL,
        from_key     TEXT    NOT NULL,
        -- What the far end is to the near end: "endpoint", "flow", "rule".
        -- Named rather than implied, so one pair of kinds can hold more than
        -- one relationship without the reader having to guess which.
        role         TEXT    NOT NULL,
        to_kind      TEXT    NOT NULL,
        to_key       TEXT    NOT NULL,
        UNIQUE (snapshot_id, from_kind, from_key, role, to_kind, to_key)
      );
      CREATE INDEX derived_links_from ON derived_links(snapshot_id, from_kind, from_key, role);
      CREATE INDEX derived_links_to ON derived_links(snapshot_id, to_kind, to_key, role);
    `,
  },
];

export const SUPPORTED_SCHEMA_VERSION: number =
  MIGRATIONS.length === 0 ? 0 : Math.max(...MIGRATIONS.map((m) => m.version));
