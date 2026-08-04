/**
 * The fact pack as a queryable database.
 *
 * Sharding the pack into one JSONL file per kind solved the wrong problem. It
 * did keep the whole pack out of the context window, but it also turned an
 * indexed database into flat text: answering "how many of each kind" became a
 * full scan of every file, and every scan's output landed back in the
 * conversation. Measured against the original trial — which queried the
 * knowledge base directly with SQL — the same work took roughly twice as long
 * and carried far more tokens, because SQL returns an aggregate where `jq`
 * returns rows.
 *
 * So the pack keeps its boundary and gets its query engine back: one SQLite file
 * per scope, holding exactly the rows the slice allows, with the same columns and
 * kinds the read contract declares. What the agent may see is unchanged; how it
 * looks is now `SELECT`.
 */

import { mkdirSync, rmSync } from "node:fs";

import { openStore } from "../store/open.js";
import type { FactPack } from "./fact-pack.js";

export interface PackDatabase {
  readonly path: string;
  /** Rows written, by kind — the same accounting the index carries. */
  readonly rowsByKind: Readonly<Record<string, number>>;
  readonly subjectCount: number;
}

const SCHEMA = `
create table facts (
  id          integer primary key,
  source      text not null,
  kind        text not null,
  key         text not null,
  payload     text not null,
  root_name   text,
  rel_path    text,
  start_line  integer,
  subject_key text
);
create index facts_kind on facts(kind);
create index facts_path on facts(rel_path);
create index facts_subject on facts(subject_key);

create table subjects (
  id       integer primary key,
  type     text not null,
  ref      text not null,
  fact_key text not null
);
create index subjects_type on subjects(type);

create table coverage (
  kind        text not null,
  source      text not null,
  in_snapshot integer not null,
  in_scope    integer not null
);

create table pack (
  snapshot_identity text not null,
  scope             text not null,
  module_id         text,
  kb_module_id      text,
  requires          text not null
);
`;

/**
 * Writes the pack as a database.
 *
 * `source` is the read contract's table name, kept because fourteen kinds are
 * served by two tables with different counts — a report that states a count for
 * one of those must still be able to say which it counted.
 */
export function writePackDatabase(pack: FactPack, directory: string): PackDatabase {
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/pack.sqlite`;
  // A resumed run cuts the pack again, and the slice is a pure function of the
  // snapshot, so the old file has nothing to preserve — while keeping it makes
  // creating the schema fail and takes the whole target down with it.
  rmSync(path, { force: true });
  const store = openStore(path);
  store.exec(SCHEMA);
  store.exec("begin");
  for (const row of pack.rows) {
    store.run(
      `insert into facts (source, kind, key, payload, root_name, rel_path, start_line, subject_key)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.table,
        row.kind,
        row.key,
        JSON.stringify(row.payload),
        row.rootName,
        row.relPath,
        row.startLine,
        row.subjectKey,
      ],
    );
  }
  for (const subject of pack.subjects) {
    store.run("insert into subjects (type, ref, fact_key) values (?, ?, ?)", [
      subject.type,
      subject.ref,
      subject.factKey,
    ]);
  }
  for (const entry of pack.coverage) {
    store.run("insert into coverage (kind, source, in_snapshot, in_scope) values (?, ?, ?, ?)", [
      entry.kind,
      entry.table,
      entry.inSnapshot,
      entry.inScope,
    ]);
  }
  store.run("insert into pack (snapshot_identity, scope, module_id, kb_module_id, requires) values (?, ?, ?, ?, ?)", [
    pack.snapshotIdentity,
    pack.scope,
    pack.moduleId,
    pack.kbModuleId,
    JSON.stringify(pack.requires),
  ]);
  store.exec("commit");

  const rowsByKind: Record<string, number> = {};
  for (const row of pack.rows) rowsByKind[row.kind] = (rowsByKind[row.kind] ?? 0) + 1;
  store.close();
  return { path, rowsByKind, subjectCount: pack.subjects.length };
}
