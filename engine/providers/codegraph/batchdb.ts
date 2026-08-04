/**
 * The batch adapter implementation (PI-6): reads a CodeGraph index database in
 * one pass instead of one subprocess per callable symbol.
 *
 * CodeGraph 1.5 has no batch edge command — only per-symbol `callees`/`callers`
 * (the N+1) and interactive `explore`/`node`/`impact`. So, as PI-5's design
 * allows, this reads the isolated CodeGraph index database
 * read-only: all nodes, all edges (every kind, not just calls) and all
 * unresolved references in three queries. The DB is CodeGraph's own format and
 * may change between versions, which is why the read is gated on the schema
 * version and fails closed. Nothing is ever written to the index.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { codeIndexDirName } from "../../artifacts.js";
import type {
  BatchAdapter,
  CodeGraphEdgeRecord,
  CodeGraphNodeRecord,
  CodeGraphSnapshot,
  SnapshotOutcome,
  UnresolvedReference,
} from "./batch.js";

/** The CodeGraph index-DB schema version this reader was verified against. */
export const SUPPORTED_DB_SCHEMA = 8;

/**
 * The index database under an index root.
 *
 * A function, and exported, because the directory it sits in is settled at read
 * time by `CODEGRAPH_DIR`. Every caller goes through this: the path was built by
 * hand in seven places, and any one of them left behind would look for a
 * database CodeGraph is not writing.
 */
export function codeIndexDbPath(indexRoot: string): string {
  return join(indexRoot, codeIndexDirName(), "codegraph.db");
}

interface NodeRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualified_name: string | null;
  readonly file_path: string | null;
  readonly language: string | null;
  readonly start_line: number | null;
  readonly end_line: number | null;
  readonly signature: string | null;
  readonly visibility: string | null;
  readonly is_exported: number | null;
}
interface EdgeRow {
  readonly id: number;
  readonly source: string;
  readonly target: string | null;
  readonly kind: string;
  readonly line: number | null;
}
interface UnresolvedRow {
  readonly from_node_id: string;
  readonly reference_name: string;
  readonly reference_kind: string | null;
  readonly file_path: string | null;
  readonly line: number | null;
  readonly status: string | null;
}
interface MetaRow {
  readonly key: string;
  readonly value: string;
}

function metaText(fields: Readonly<Record<string, string | null>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== "") out[key] = value;
  }
  return out;
}

/** Gates and reads an already-open index DB. Separated so it is testable in memory. */
export function snapshotFromDb(db: DatabaseSync, indexRoot: string): SnapshotOutcome {
  const schema = (db.prepare("SELECT max(version) AS v FROM schema_versions").get() as { v: number | null } | undefined)?.v ?? null;
  if (schema !== SUPPORTED_DB_SCHEMA) {
    return { ok: false, degradation: { kind: "schema-unsupported", found: String(schema), supported: String(SUPPORTED_DB_SCHEMA) } };
  }

  const meta = new Map(
    (db.prepare("SELECT key, value FROM project_metadata").all() as unknown as MetaRow[]).map((r) => [r.key, r.value] as const),
  );
  if (meta.get("index_state") !== "complete") {
    return { ok: false, degradation: { kind: "index-incomplete", detail: `index_state=${meta.get("index_state") ?? "unknown"}` } };
  }
  if (meta.get("index_files_discovered") !== meta.get("index_files_accounted")) {
    return {
      ok: false,
      degradation: {
        kind: "index-incomplete",
        detail: `files accounted ${meta.get("index_files_accounted") ?? "?"}/${meta.get("index_files_discovered") ?? "?"}`,
      },
    };
  }

  const nodeFile = new Map<string, string>();
  const nodes: CodeGraphNodeRecord[] = (
    db
      .prepare(
        "SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, signature, visibility, is_exported FROM nodes",
      )
      .all() as unknown as NodeRow[]
  ).map((n) => {
    const filePath = n.file_path ?? "";
    nodeFile.set(n.id, filePath);
    return {
      nativeId: n.id,
      kind: n.kind,
      name: n.name,
      filePath,
      startLine: n.start_line,
      endLine: n.end_line,
      metadata: metaText({
        qualifiedName: n.qualified_name,
        language: n.language,
        signature: n.signature,
        visibility: n.visibility,
        isExported: n.is_exported != null ? String(n.is_exported) : null,
      }),
    };
  });

  const edges: CodeGraphEdgeRecord[] = (
    db.prepare("SELECT id, source, target, kind, line FROM edges").all() as unknown as EdgeRow[]
  ).map((e) => ({
    nativeId: String(e.id),
    kind: e.kind,
    fromNativeId: e.source,
    toNativeId: e.target ?? null,
    filePath: nodeFile.get(e.source) ?? "",
    startLine: e.line,
  }));

  const unresolvedReferences: UnresolvedReference[] = (
    db
      .prepare("SELECT from_node_id, reference_name, reference_kind, file_path, line, status FROM unresolved_refs")
      .all() as unknown as UnresolvedRow[]
  ).map((u) => ({
    fromNativeId: u.from_node_id,
    name: u.reference_name,
    filePath: u.file_path ?? "",
    startLine: u.line,
    reason: `${u.reference_kind ?? "reference"}: ${u.status ?? "unresolved"}`,
  }));

  const snapshot: CodeGraphSnapshot = {
    nodes,
    edges,
    unresolvedReferences,
    metadata: {
      codegraphVersion: meta.get("indexed_with_version") ?? "unknown",
      schemaVersion: String(schema),
      indexRoot,
      rootPrefixes: [],
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    truncation: { truncated: false, limit: null, reason: null },
  };
  return { ok: true, snapshot };
}

/** Reads the index DB at `dbPath` read-only. Missing index fails closed. */
export function readBatchDb(dbPath: string, indexRoot: string): SnapshotOutcome {
  if (!existsSync(dbPath)) {
    return { ok: false, degradation: { kind: "index-build-failed", detail: `no CodeGraph index at ${dbPath}` } };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return snapshotFromDb(db, indexRoot);
  } finally {
    db.close();
  }
}

export function createBatchDbAdapter(): BatchAdapter {
  return { read: (indexRoot: string) => readBatchDb(codeIndexDbPath(indexRoot), indexRoot) };
}
