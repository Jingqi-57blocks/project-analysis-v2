import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { MIGRATIONS, SUPPORTED_SCHEMA_VERSION } from "./migrations.js";
import { SchemaTooNewError, type SqlParams, type SqlValue, type Store } from "./types.js";

/**
 * SQLite comes from the runtime rather than a native package, so the tool has
 * no build step and installs anywhere Node runs. It is still marked
 * experimental, which is why every caller goes through `Store` — replacing the
 * driver should touch this file and nothing else.
 */

export const IN_MEMORY = ":memory:";

function toBindings(params: SqlParams | undefined): SqlValue[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? [...(params as readonly SqlValue[])] : [];
}

function namedBindings(params: SqlParams | undefined): Record<string, SqlValue> | null {
  if (params === undefined || Array.isArray(params)) return null;
  return { ...(params as Record<string, SqlValue>) };
}

class SqliteStore implements Store {
  #db: DatabaseSync;
  #depth = 0;
  #savepoint = 0;
  schemaVersion: number;

  constructor(db: DatabaseSync, schemaVersion: number) {
    this.#db = db;
    this.schemaVersion = schemaVersion;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, params?: SqlParams): number {
    const statement = this.#db.prepare(sql);
    const named = namedBindings(params);
    const result = named ? statement.run(named) : statement.run(...toBindings(params));
    return Number(result.changes);
  }

  all<T>(sql: string, params?: SqlParams): T[] {
    const statement = this.#db.prepare(sql);
    const named = namedBindings(params);
    const rows = named ? statement.all(named) : statement.all(...toBindings(params));
    return rows as T[];
  }

  get<T>(sql: string, params?: SqlParams): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  /**
   * Nested calls use savepoints rather than rejecting or silently flattening,
   * so a helper that wants atomicity is safe to call from inside a larger
   * transaction.
   */
  transaction<T>(fn: () => T): T {
    const nested = this.#depth > 0;
    const name = nested ? `sp_${++this.#savepoint}` : null;

    this.#db.exec(name ? `SAVEPOINT ${name}` : "BEGIN");
    this.#depth += 1;

    try {
      const result = fn();
      this.#db.exec(name ? `RELEASE ${name}` : "COMMIT");
      return result;
    } catch (error) {
      this.#db.exec(name ? `ROLLBACK TO ${name}` : "ROLLBACK");
      if (name) this.#db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  close(): void {
    this.#db.close();
  }
}

function currentVersion(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `);
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/** Applies pending migrations in order. Re-opening an up-to-date database is a no-op. */
function migrate(db: DatabaseSync, appliedAt: string): number {
  const found = currentVersion(db);

  if (found > SUPPORTED_SCHEMA_VERSION) {
    throw new SchemaTooNewError(found, SUPPORTED_SCHEMA_VERSION);
  }

  const pending = MIGRATIONS.filter((m) => m.version > found).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        appliedAt,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return SUPPORTED_SCHEMA_VERSION;
}

export interface OpenOptions {
  /** Timestamp recorded against applied migrations. Injectable for determinism. */
  readonly now?: string;
}

/**
 * Opens a knowledge base, creating and migrating it if needed.
 *
 * Pass `IN_MEMORY` for tests: they should not need a filesystem.
 */
export function openStore(path: string, options: OpenOptions = {}): Store {
  if (path !== IN_MEMORY) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");

  try {
    const version = migrate(db, options.now ?? new Date().toISOString());
    return new SqliteStore(db, version);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Thrown when a reader is pointed at a path that holds no knowledge base. */
export class NoSuchStoreError extends Error {
  constructor(readonly path: string) {
    super(`No knowledge base at ${path}. Run \`analyze\` first, or correct --db.`);
    this.name = "NoSuchStoreError";
  }
}

/**
 * Opens an existing knowledge base without the power to change it.
 *
 * `openStore` creates and migrates, which is right for the analysis that owns
 * the base and wrong for everything downstream. A reader that creates is a
 * reader that answers a mistyped `--db` with an empty database instead of an
 * error, and a reader that migrates rewrites the very artefact it was asked to
 * read — under a schema the run that produced the data never saw.
 *
 * So this refuses a missing file, opens read-only, and does not migrate. An
 * older base is readable as it stands; a newer one is refused, because this
 * build cannot know what the extra migrations mean.
 */
export function openStoreReadonly(path: string): Store {
  if (path === IN_MEMORY) throw new NoSuchStoreError(path);
  if (!existsSync(path)) throw new NoSuchStoreError(path);

  const db = new DatabaseSync(path, { readOnly: true });

  try {
    // Read directly rather than through `currentVersion`, which creates the
    // table it reads — impossible here, and the attempt is the bug this guards.
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
      | { v: number | null }
      | undefined;
    const found = row?.v ?? 0;
    if (found > SUPPORTED_SCHEMA_VERSION) throw new SchemaTooNewError(found, SUPPORTED_SCHEMA_VERSION);
    return new SqliteStore(db, found);
  } catch (error) {
    db.close();
    throw error;
  }
}
