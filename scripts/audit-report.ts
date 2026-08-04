/**
 * Audit a report against the knowledge base it claims to have been written from.
 *
 *   pnpm audit:report -- <reportPath> [--db .analysis/kb.sqlite]
 *
 * This is the whole of the report layer's tooling. Reading the base and writing
 * the document are the skill's job; this is the part the author cannot do for
 * itself, because an agent grading its own report is the failure being guarded
 * against.
 *
 * Writes `audit.json` next to the report and exits non-zero when the report is
 * not a deliverable. A report directory with no passing verdict beside it is not
 * a deliverable, whatever the report says about itself.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CHECKLIST_IDS } from "../engine/contracts/report/checklist.js";
import { auditReport, explainAudit, readInventory, resolveIdentities } from "../engine/report/kb-audit.js";
import { openStore } from "../engine/store/open.js";

/**
 * Argument parsing, walked once rather than searched.
 *
 * The first version searched for the positional with `argv.find`, which broke on a
 * bare `--` — pnpm forwards one through, and the search then skipped every
 * argument whose predecessor started with a dash. The command printed in the
 * instructions was unrunnable as written. Walking the list and consuming each
 * flag's value cannot go wrong that way.
 */
const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positionals: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? "";
  if (arg === "--") continue;
  if (arg.startsWith("--")) {
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      flags.set(arg.slice(2), value);
      index += 1;
    } else {
      flags.set(arg.slice(2), "");
    }
    continue;
  }
  positionals.push(arg);
}
const flag = (name: string, fallback: string): string => flags.get(name) || fallback;

const reportPath = positionals[0];
if (reportPath === undefined) {
  console.error("usage: pnpm audit:report <reportPath> [--db <kb.sqlite>]");
  process.exit(2);
}

const dbPath = resolve(flag("db", ".analysis/kb.sqlite"));
const store = openStore(dbPath);
const snapshot = store.get<{ id: number }>("select id from snapshots order by id desc limit 1");
if (snapshot === undefined) {
  console.error(`${dbPath} holds no snapshot`);
  process.exit(2);
}

const report = readFileSync(resolve(reportPath), "utf8");
const runDir = dirname(resolve(reportPath));
const checklistPath = `${runDir}/checklist.json`;
const result = auditReport({
  report,
  inventory: readInventory(store, snapshot.id),
  requiredChecklistIds: CHECKLIST_IDS,
  ...(existsSync(checklistPath) ? { checklist: readFileSync(checklistPath, "utf8") } : {}),
  resolveIds: (ids) => resolveIdentities(store, snapshot.id, ids),
});

const verdictPath = `${runDir}/audit.json`;
writeFileSync(
  verdictPath,
  JSON.stringify(
    { report: resolve(reportPath), snapshotId: snapshot.id, passed: result.passed, findings: result.findings, checklist: result.checklist },
    null,
    2,
  ) + "\n",
);

console.log(explainAudit(result));
console.log(`verdict → ${verdictPath}`);
store.close();
if (!result.passed) process.exit(1);
