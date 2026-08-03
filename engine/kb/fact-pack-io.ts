/**
 * Writing a fact pack to disk.
 *
 * A project-scope pack runs to tens of thousands of rows. Handing that to the
 * skill as one blob would not fit its context, and paging through a single large
 * JSON file is awkward — so the pack is written as an index plus one line-oriented
 * file per kind. The skill reads the index, then opens only the kinds it needs,
 * and can search within a kind without loading it whole.
 *
 * The index alone answers "what is in scope, and how much of it", which is what
 * the mandatory walk-every-kind step needs.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import type { FactPack } from "./fact-pack.js";

export interface FactPackIndex {
  readonly snapshotIdentity: string;
  readonly scope: string;
  readonly moduleId: string | null;
  readonly kbModuleId: string | null;
  readonly requires: readonly string[];
  readonly kinds: readonly {
    readonly kind: string;
    readonly file: string;
    /**
     * Rows per table, never a single total. Fourteen kinds are served by both
     * the structural and the behavioural table, so one underlying fact appears
     * as two rows; a single number would read as twice as many facts.
     */
    readonly rowsByTable: Readonly<Record<string, number>>;
    readonly coverage: FactPack["coverage"];
  }[];
  /** Written separately: a project pack has tens of thousands. */
  readonly subjectsFile: string;
  readonly subjectCount: number;
  /** Kinds the spec asked for that have no rows in scope — a fact to report. */
  readonly emptyKinds: readonly string[];
}

/** Writes `index.json` and `kinds/<kind>.jsonl`, and returns the index. */
export function writeFactPack(pack: FactPack, directory: string): FactPackIndex {
  mkdirSync(`${directory}/kinds`, { recursive: true });
  const kinds: FactPackIndex["kinds"] = [...new Set(pack.rows.map((row) => row.kind))].sort().map((kind) => {
    const rows = pack.rows.filter((row) => row.kind === kind);
    const file = `kinds/${kind}.jsonl`;
    writeFileSync(`${directory}/${file}`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const rowsByTable: Record<string, number> = {};
    for (const row of rows) rowsByTable[row.table] = (rowsByTable[row.table] ?? 0) + 1;
    return { kind, file, rowsByTable, coverage: pack.coverage.filter((entry) => entry.kind === kind) };
  });
  const subjectsFile = "subjects.jsonl";
  writeFileSync(
    `${directory}/${subjectsFile}`,
    pack.subjects.map((subject) => JSON.stringify(subject)).join("\n") + "\n",
  );
  const present = new Set(kinds.map((entry) => entry.kind));
  const index: FactPackIndex = {
    snapshotIdentity: pack.snapshotIdentity,
    scope: pack.scope,
    moduleId: pack.moduleId,
    kbModuleId: pack.kbModuleId,
    requires: pack.requires,
    kinds,
    subjectsFile,
    subjectCount: pack.subjects.length,
    emptyKinds: pack.requires.filter((kind) => !present.has(kind)).sort(),
  };
  writeFileSync(`${directory}/index.json`, JSON.stringify(index, null, 1) + "\n");
  return index;
}
