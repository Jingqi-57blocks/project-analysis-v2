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

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CHECKLIST_IDS } from "../engine/contracts/report/checklist.js";
import { auditReport, explainAudit, readInventory, resolveIdentities } from "../engine/report/kb-audit.js";
import { openStore } from "../engine/store/open.js";

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const reportPath = argv.find((arg) => !arg.startsWith("--") && argv[argv.indexOf(arg) - 1]?.startsWith("--") !== true);
if (reportPath === undefined) {
  console.error("usage: pnpm audit:report -- <reportPath> [--db <kb.sqlite>]");
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
const result = auditReport({
  report,
  inventory: readInventory(store, snapshot.id),
  requiredChecklistIds: CHECKLIST_IDS,
  resolveIds: (ids) => resolveIdentities(store, snapshot.id, ids),
});

const verdictPath = `${dirname(resolve(reportPath))}/audit.json`;
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
