import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../../engine/store/migrations.js";
import { IN_MEMORY, NoSuchStoreError, openStore, openStoreReadonly } from "../../engine/store/open.js";
import { SchemaTooNewError, type Store } from "../../engine/store/types.js";

let store: Store;
let workDir: string;

beforeEach(() => {
  store = openStore(IN_MEMORY);
  workDir = mkdtempSync(join(tmpdir(), "pa-store-"));
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("migration", () => {
  it("applies every migration on a fresh database", () => {
    expect(store.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
  });

  it("records what it applied", () => {
    const applied = store.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(applied.length).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(applied[0]?.name).toBe("base-tables");
  });

  it("creates the base tables", () => {
    const names = store
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);

    for (const table of ["workspaces", "snapshots", "source_roots", "files", "phase_metrics"]) {
      expect(names, `missing ${table}`).toContain(table);
    }
  });

  it("re-opening an up-to-date database changes nothing", () => {
    const path = join(workDir, "kb.sqlite");

    const first = openStore(path, { now: "2020-01-01T00:00:00.000Z" });
    const firstApplied = first.all("SELECT * FROM schema_migrations");
    first.close();

    const second = openStore(path, { now: "2030-01-01T00:00:00.000Z" });
    const secondApplied = second.all("SELECT * FROM schema_migrations");
    second.close();

    expect(secondApplied).toEqual(firstApplied);
  });

  it("creates parent directories for the database file", () => {
    const path = join(workDir, "nested", "deeper", "kb.sqlite");
    openStore(path).close();
    expect(existsSync(path)).toBe(true);
  });

  it("refuses a database written by a newer build", () => {
    const path = join(workDir, "future.sqlite");
    const created = openStore(path);
    created.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
      SUPPORTED_SCHEMA_VERSION + 1,
      "from-the-future",
      "2030-01-01T00:00:00.000Z",
    ]);
    created.close();

    expect(() => openStore(path)).toThrow(SchemaTooNewError);
  });
});

describe("opening a base read-only", () => {
  it("refuses a path that holds nothing, rather than creating one there", () => {
    const path = join(workDir, "typo.sqlite");

    expect(() => openStoreReadonly(path)).toThrow(NoSuchStoreError);
    expect(existsSync(path)).toBe(false);
  });

  it("reads an existing base without rewriting its schema history", () => {
    const path = join(workDir, "kb.sqlite");
    const created = openStore(path, { now: "2020-01-01T00:00:00.000Z" });
    created.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/a", "t0"]);
    const before = created.all("SELECT * FROM schema_migrations");
    created.close();

    const reader = openStoreReadonly(path);
    expect(reader.get<{ path: string }>("SELECT path FROM workspaces")?.path).toBe("/a");
    expect(reader.all("SELECT * FROM schema_migrations")).toEqual(before);
    reader.close();
  });

  it("cannot write, whatever the caller asks for", () => {
    const path = join(workDir, "kb.sqlite");
    openStore(path).close();

    const reader = openStoreReadonly(path);
    expect(() => reader.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/a", "t0"])).toThrow();
    reader.close();
  });

  it("refuses a database written by a newer build", () => {
    const path = join(workDir, "future.sqlite");
    const created = openStore(path);
    created.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
      SUPPORTED_SCHEMA_VERSION + 1,
      "from-the-future",
      "2030-01-01T00:00:00.000Z",
    ]);
    created.close();

    expect(() => openStoreReadonly(path)).toThrow(SchemaTooNewError);
  });
});

describe("queries", () => {
  beforeEach(() => {
    store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/a", "t0"]);
  });

  it("reports how many rows a statement changed", () => {
    const changed = store.run("UPDATE workspaces SET created_at = ? WHERE path = ?", ["t1", "/a"]);
    expect(changed).toBe(1);
  });

  it("reads rows back with positional parameters", () => {
    const row = store.get<{ path: string }>("SELECT path FROM workspaces WHERE path = ?", ["/a"]);
    expect(row?.path).toBe("/a");
  });

  it("reads rows back with named parameters", () => {
    const row = store.get<{ path: string }>("SELECT path FROM workspaces WHERE path = $path", {
      $path: "/a",
    });
    expect(row?.path).toBe("/a");
  });

  it("returns undefined rather than throwing when nothing matches", () => {
    expect(store.get("SELECT path FROM workspaces WHERE path = ?", ["/nope"])).toBeUndefined();
  });

  it("enforces foreign keys", () => {
    expect(() =>
      store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (?, ?, ?)", [
        9999,
        "x",
        "t0",
      ]),
    ).toThrow();
  });

  it("enforces the file disposition vocabulary", () => {
    store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (1, 'i', 't')");
    store.run(
      "INSERT INTO source_roots (snapshot_id, name, path, content_digest) VALUES (1, 'r', '/r', 'd')",
    );

    expect(() =>
      store.run(
        "INSERT INTO files (source_root_id, rel_path, size_bytes, disposition) VALUES (1, 'a', 1, ?)",
        ["invented"],
      ),
    ).toThrow();
  });
});

describe("transactions", () => {
  it("commits work that completes", () => {
    store.transaction(() => {
      store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/committed", "t0"]);
    });
    expect(store.get("SELECT path FROM workspaces WHERE path = ?", ["/committed"])).toBeDefined();
  });

  it("leaves no partial rows when the body throws", () => {
    expect(() =>
      store.transaction(() => {
        store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/a", "t0"]);
        store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/b", "t0"]);
        throw new Error("stage failed halfway");
      }),
    ).toThrow("stage failed halfway");

    expect(store.all("SELECT path FROM workspaces")).toEqual([]);
  });

  it("nests without losing the outer transaction", () => {
    store.transaction(() => {
      store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/outer", "t0"]);
      store.transaction(() => {
        store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/inner", "t0"]);
      });
    });

    expect(store.all("SELECT path FROM workspaces").length).toBe(2);
  });

  it("rolls back only the inner scope when a nested transaction fails", () => {
    store.transaction(() => {
      store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/outer", "t0"]);
      try {
        store.transaction(() => {
          store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/inner", "t0"]);
          throw new Error("inner failed");
        });
      } catch {
        // recovered: the outer scope decides to continue
      }
    });

    const paths = store.all<{ path: string }>("SELECT path FROM workspaces").map((r) => r.path);
    expect(paths).toEqual(["/outer"]);
  });

  it("rolls the whole thing back when an outer transaction fails after a nested one", () => {
    expect(() =>
      store.transaction(() => {
        store.transaction(() => {
          store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/inner", "t0"]);
        });
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");

    expect(store.all("SELECT path FROM workspaces")).toEqual([]);
  });

  it("returns the body's value", () => {
    expect(store.transaction(() => 42)).toBe(42);
  });
});
