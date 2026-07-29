/**
 * Writes a knowledge base out as one JSON document.
 *
 *   pnpm run export -- [--db path] [--run id] [--out path]
 *
 * Reads a stored analysis; it never opens the project. A knowledge base can be
 * exported on a machine that does not have the source at all, and the same run
 * exported twice produces the same bytes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../engine/store/open.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { renderExport } from "../engine/kb/export.js";

const DEFAULT_DB_PATH = "./.analysis/kb.sqlite";

function main(argv: readonly string[]): number {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const dbPath = resolve(value("--db") ?? DEFAULT_DB_PATH);
  const runId = value("--run");

  const store = openStore(dbPath);
  try {
    const kb = openKnowledgeBase(store, runId);
    // Named after the run rather than overwritten. Two runs of a changing
    // codebase are two answers, and losing the first loses the comparison that
    // made the second worth doing.
    const outPath = resolve(
      value("--out") ?? `./.analysis/export/${kb.snapshot.runId ?? kb.snapshot.id}.json`,
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, renderExport(kb), "utf8");

    console.log(`Exported run ${kb.snapshot.runId ?? "(unnamed)"} of ${kb.snapshot.workspacePath}`);
    console.log(`  ${kb.features().length} capabilities, ${kb.modules().length} modules`);
    console.log(`  ${outPath}`);
    return 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
