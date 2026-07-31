import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { readBatchDb, snapshotFromDb, SUPPORTED_DB_SCHEMA } from "../../engine/providers/codegraph/batchdb.js";

interface BuildOptions {
  readonly schema?: number;
  readonly indexState?: string;
  readonly discovered?: string;
  readonly accounted?: string;
}

/** A minimal DB shaped like a CodeGraph index, in memory. */
function buildDb(options: BuildOptions = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE schema_versions (version INTEGER, applied_at INTEGER, description TEXT);
    CREATE TABLE project_metadata (key TEXT, value TEXT);
    CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, language TEXT,
                        start_line INTEGER, end_line INTEGER, signature TEXT, visibility TEXT, is_exported INTEGER);
    CREATE TABLE edges (id INTEGER, source TEXT, target TEXT, kind TEXT, line INTEGER);
    CREATE TABLE unresolved_refs (from_node_id TEXT, reference_name TEXT, reference_kind TEXT, file_path TEXT, line INTEGER, status TEXT);
  `);
  db.prepare("INSERT INTO schema_versions VALUES (?,?,?)").run(options.schema ?? SUPPORTED_DB_SCHEMA, 0, "test");
  const meta: readonly (readonly [string, string])[] = [
    ["index_state", options.indexState ?? "complete"],
    ["indexed_with_version", "1.5.0"],
    ["index_files_discovered", options.discovered ?? "2"],
    ["index_files_accounted", options.accounted ?? "2"],
  ];
  for (const [k, v] of meta) db.prepare("INSERT INTO project_metadata VALUES (?,?)").run(k, v);
  db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("sym:A", "function", "A", "pkg.A", "a.go", "go", 10, 20, "func A()", "public", 1);
  db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("sym:B", "function", "B", "pkg.B", "a.go", "go", 30, 40, null, null, 0);
  db.prepare("INSERT INTO edges VALUES (?,?,?,?,?)").run(1, "sym:A", "sym:B", "calls", 12);
  db.prepare("INSERT INTO unresolved_refs VALUES (?,?,?,?,?,?)").run("sym:A", "ThirdParty", "calls", "a.go", 15, "failed");
  return db;
}

describe("codegraph batch DB reader", () => {
  it("reads nodes, all edges and unresolved refs in one pass", () => {
    const db = buildDb();
    const outcome = snapshotFromDb(db, "/idx");
    db.close();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const s = outcome.snapshot;
    expect(s.nodes).toHaveLength(2);
    expect(s.edges).toHaveLength(1);
    expect(s.edges[0]!.kind).toBe("calls");
    expect(s.edges[0]!.filePath).toBe("a.go"); // derived from the source node
    expect(s.unresolvedReferences[0]!.reason).toContain("failed");
    expect(s.metadata.codegraphVersion).toBe("1.5.0");
    expect(s.metadata.schemaVersion).toBe(String(SUPPORTED_DB_SCHEMA));
    expect(s.nodes[0]!.nativeId).toBe("sym:A"); // raw id, not a canonical FactId
    expect(s.nodes[0]!.metadata.qualifiedName).toBe("pkg.A");
  });

  it("fails closed on an unsupported schema", () => {
    const db = buildDb({ schema: 7 });
    const outcome = snapshotFromDb(db, "/idx");
    db.close();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.degradation.kind).toBe("schema-unsupported");
  });

  it("fails closed on an incomplete index", () => {
    const partialDb = buildDb({ indexState: "partial" });
    const partial = snapshotFromDb(partialDb, "/idx");
    partialDb.close();
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.degradation.kind).toBe("index-incomplete");

    const shortDb = buildDb({ discovered: "10", accounted: "8" });
    const short = snapshotFromDb(shortDb, "/idx");
    shortDb.close();
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.degradation.kind).toBe("index-incomplete");
  });

  it("fails closed when there is no index", () => {
    const outcome = readBatchDb("/nonexistent/.codegraph/codegraph.db", "/idx");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.degradation.kind).toBe("index-build-failed");
  });

  it("reads the real WCP-V2 derived-variant index when present", () => {
    const root = ".targets/wcp-v2-wcp-auth-no-manifest";
    const dbPath = `${root}/.codegraph/codegraph.db`;
    if (!existsSync(dbPath)) return; // derived variant absent (e.g. in CI) — skip gracefully
    const outcome = readBatchDb(dbPath, root);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.snapshot.nodes.length).toBeGreaterThan(0);
    // One batch read gives every edge kind — including ones the CLI never exposed.
    const kinds = new Set(outcome.snapshot.edges.map((e) => e.kind));
    expect(kinds.has("contains")).toBe(true);
    expect(outcome.snapshot.unresolvedReferences.length).toBeGreaterThan(0);
  });
});
