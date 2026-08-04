/**
 * Read one snapshot of a knowledge base, from the outside.
 *
 *   pnpm kb:query --db .analysis/kb.sqlite --run <runId> --sql "select ..."
 *
 * Why this exists rather than `sqlite3 -readonly`: almost every table in the
 * base is snapshot-scoped, and a query that forgets `snapshot_id` silently
 * counts across every analysis the file holds — several workspaces, several
 * runs, and any snapshot a failed run left unpublished. Nothing about the
 * output says so. The numbers just come back larger.
 *
 * So the snapshot is resolved here, bound as `:snapshot`, and a query that
 * touches a snapshot-scoped table without using it is refused. The refusal is
 * the point: the reader cannot decide to skip the scope, because forgetting is
 * exactly how it goes wrong.
 */

import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveSnapshot } from "../engine/kb/query.js";
import { openStoreReadonly } from "../engine/store/open.js";
import type { SqlValue } from "../engine/store/types.js";
import { reportRefusals } from "./refusals.js";

reportRefusals();

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? "";
  if (arg === "--" || !arg.startsWith("--")) continue;
  const value = argv[index + 1];
  if (value !== undefined && !value.startsWith("--")) {
    flags.set(arg.slice(2), value);
    index += 1;
  } else {
    flags.set(arg.slice(2), "");
  }
}

const sql = flags.get("sql");
if (sql === undefined || sql.trim() === "") {
  console.error(
    'usage: pnpm kb:query --sql "select ..." [--db <kb.sqlite>] [--run <runId>] [--log <queries.log>] [--json]',
  );
  process.exit(2);
}

/**
 * Reads only. The driver would refuse a write against a read-only handle
 * anyway; this refuses earlier and says why, so an attempted write reads as a
 * mistake about what this command is for rather than as a driver error.
 */
const leading = sql.trimStart().slice(0, 6).toLowerCase();
if (leading !== "select" && leading !== "with") {
  console.error("kb:query runs SELECT (or WITH ... SELECT) only — the base is read-only from here.");
  process.exit(2);
}

const dbPath = resolve(flags.get("db") || ".analysis/kb.sqlite");
const store = openStoreReadonly(dbPath);
const runId = flags.get("run");
const snapshot = resolveSnapshot(store, runId || undefined, flags.get("workspace") || undefined);

/**
 * The tables that mean nothing without a snapshot, read from the schema rather
 * than listed — a list would go stale the first time a migration adds a table,
 * and a table missing from it would be the one that silently spans snapshots.
 *
 * Scoping is transitive, which is the part a hand-written list gets wrong.
 * `files` carries no `snapshot_id`; it hangs off `source_roots`, which does. So
 * `select count(*) from files` counts the files of every analysis in the file
 * and looks exactly like a correct answer. Following the foreign keys catches
 * that whole class without anyone having to remember which tables are which.
 */
const direct = store
  .all<{ name: string }>(
    `SELECT DISTINCT m.name FROM sqlite_master m
     JOIN pragma_table_info(m.name) c
     WHERE m.type = 'table' AND c.name = 'snapshot_id'`,
  )
  .map((row) => row.name);

const references = store.all<{ name: string; parent: string }>(
  `SELECT m.name, f."table" AS parent FROM sqlite_master m
   JOIN pragma_foreign_key_list(m.name) f
   WHERE m.type = 'table'`,
);

const scoped = new Set(direct);
for (let changed = true; changed; ) {
  changed = false;
  for (const edge of references) {
    if (!scoped.has(edge.name) && scoped.has(edge.parent)) {
      scoped.add(edge.name);
      changed = true;
    }
  }
}

const mentioned = [...scoped].filter((table) => new RegExp(`\\b${table}\\b`).test(sql));
if (mentioned.length > 0 && !sql.includes(":snapshot")) {
  const indirect = mentioned.filter((table) => !direct.includes(table));
  console.error(
    `this query reads ${mentioned.join(", ")}, which ${mentioned.length === 1 ? "is" : "are"} snapshot-scoped, ` +
      `but never mentions :snapshot.\n` +
      `Without it the result spans every analysis in ${dbPath}. Add, for example:\n` +
      `  where snapshot_id = :snapshot` +
      (indirect.length === 0
        ? ""
        : `\n${indirect.join(", ")} ${indirect.length === 1 ? "carries" : "carry"} no snapshot_id of its own — ` +
          `reach it through the table that does, e.g.\n` +
          `  join source_roots r on r.id = files.source_root_id where r.snapshot_id = :snapshot`),
  );
  store.close();
  process.exit(2);
}

// Bound only when the query asks for it: the driver rejects a named parameter
// the statement never declares, and a query over unscoped tables legitimately
// has none.
const rows = sql.includes(":snapshot")
  ? store.all<Record<string, SqlValue>>(sql, { snapshot: snapshot.id })
  : store.all<Record<string, SqlValue>>(sql);

if (flags.has("json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  // Pipe-separated and headerless, matching `sqlite3`'s default so the reading
  // guidance stays true whichever of the two is used — including its warning
  // that an identifier read out of a multi-column row loses its escaping.
  for (const row of rows) {
    console.log(Object.values(row).map((value) => (value === null ? "" : String(value))).join("|"));
  }
}

/**
 * The log records what was asked, not what came back.
 *
 * It is how anyone later tells an investigation from a census, so it is written
 * by the command rather than by the author: a log the author maintains by hand
 * is a log that records what the author remembers running.
 */
const logPath = flags.get("log");
if (logPath) {
  const line = sql.replace(/\s+/g, " ").trim();
  appendFileSync(resolve(logPath), `${line}\n`, "utf8");
  if (!existsSync(resolve(logPath))) console.error(`could not write ${logPath}`);
}

store.close();
