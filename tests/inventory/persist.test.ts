import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { recordInventory } from "../../engine/inventory/persist.js";
import { walkRoot } from "../../engine/inventory/walk.js";

let store: Store;
let root: string;
let sourceRootId: number;

function write(relativePath: string, contents = "x"): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  store = openStore(IN_MEMORY);
  root = mkdtempSync(join(tmpdir(), "pa-inventory-persist-"));

  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't0')");
  store.run(
    "INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'id', 't0', NULL)",
  );
  store.run(
    `INSERT INTO source_roots (snapshot_id, name, path, content_digest, vcs)
     VALUES (1, 'root', ?, 'digest', 'none')`,
    [root],
  );
  sourceRootId = store.get<{ id: number }>("SELECT id FROM source_roots WHERE name = 'root'")!.id;
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("recordInventory — accounting", () => {
  it("returns counts that reconcile with what was written", () => {
    write("a.ts");
    write("b.ts");
    write("node_modules/dep/index.js");

    const counts = recordInventory(store, sourceRootId, walkRoot(root));

    expect(counts).toEqual({ discovered: 3, analyzed: 2, excluded: 1, unsupported: 0, failed: 0 });
  });

  it("discovered always equals the sum of the other four counts", () => {
    write("a.ts");
    write("node_modules/x/y.js");
    write(".git/HEAD");

    const counts = recordInventory(store, sourceRootId, walkRoot(root));

    expect(counts.discovered).toBe(
      counts.analyzed + counts.excluded + counts.unsupported + counts.failed,
    );
  });

  it("keeps unsupported honestly at zero — no current signal produces it", () => {
    write("a.ts");
    const counts = recordInventory(store, sourceRootId, walkRoot(root));
    expect(counts.unsupported).toBe(0);
  });
});

describe("recordInventory — persistence", () => {
  it("writes one files row per analyzed file, with its classification", () => {
    write("a.ts");
    write("README.md");

    recordInventory(store, sourceRootId, walkRoot(root));

    const rows = store.all<{ rel_path: string; disposition: string; classification: string | null }>(
      "SELECT rel_path, disposition, classification FROM files WHERE source_root_id = ? ORDER BY rel_path",
      [sourceRootId],
    );

    expect(rows).toEqual([
      { rel_path: "README.md", disposition: "analyzed", classification: "documentation" },
      { rel_path: "a.ts", disposition: "analyzed", classification: "source" },
    ]);
  });

  it("writes one row for an excluded dependency directory, with a reason and no classification", () => {
    write("node_modules/dep/index.js");
    recordInventory(store, sourceRootId, walkRoot(root));

    const row = store.get<{ disposition: string; classification: string | null; reason: string | null }>(
      "SELECT disposition, classification, reason FROM files WHERE source_root_id = ? AND rel_path = 'node_modules'",
      [sourceRootId],
    );

    expect(row?.disposition).toBe("excluded");
    expect(row?.classification).toBeNull();
    expect(row?.reason?.length).toBeGreaterThan(0);
  });

  it("writes each file's size in bytes", () => {
    write("a.ts", "0123456789"); // 10 bytes
    recordInventory(store, sourceRootId, walkRoot(root));

    const row = store.get<{ size_bytes: number }>(
      "SELECT size_bytes FROM files WHERE source_root_id = ? AND rel_path = 'a.ts'",
      [sourceRootId],
    );
    expect(row?.size_bytes).toBe(10);
  });

  it("commits nothing if the transaction is interrupted", () => {
    write("a.ts");
    write("b.ts");

    // Force a failure partway by inserting a row that collides with the
    // UNIQUE(source_root_id, rel_path) constraint before recordInventory runs,
    // proving a failure inside its transaction leaves no partial rows.
    store.run(
      "INSERT INTO files (source_root_id, rel_path, size_bytes, disposition) VALUES (?, 'a.ts', 0, 'analyzed')",
      [sourceRootId],
    );

    expect(() => recordInventory(store, sourceRootId, walkRoot(root))).toThrow();

    const rows = store.all("SELECT rel_path FROM files WHERE source_root_id = ? AND rel_path != 'a.ts'", [
      sourceRootId,
    ]);
    // b.ts must not have been committed even though it was processed after
    // the row that later collided during insertion of a.ts.
    expect(rows).toEqual([]);
  });
});

describe("recordInventory — real fixture end to end", () => {
  it("round-trips a small realistic tree through walk and persist", () => {
    write("src/index.ts", "export const a = 1;\n");
    write("src/index_test.ts", "test('x', () => {});\n");
    write("migrations/0001_init.sql", "CREATE TABLE t (id INT);\n");
    write(".env", "SECRET=shh\n");
    write("node_modules/dep/index.js", "module.exports = {};\n");

    const counts = recordInventory(store, sourceRootId, walkRoot(root));

    expect(counts.analyzed).toBe(4);
    expect(counts.excluded).toBe(1);
    expect(counts.discovered).toBe(5);

    const classifications = store
      .all<{ rel_path: string; classification: string | null }>(
        "SELECT rel_path, classification FROM files WHERE disposition = 'analyzed' ORDER BY rel_path",
        [],
      )
      .reduce<Record<string, string | null>>((acc, r) => {
        acc[r.rel_path] = r.classification;
        return acc;
      }, {});

    expect(classifications[".env"]).toBe("configuration");
    expect(classifications[join("migrations", "0001_init.sql")]).toBe("schema-migration");
    expect(classifications[join("src", "index_test.ts")]).toBe("test");
    expect(classifications[join("src", "index.ts")]).toBe("source");
  });
});
