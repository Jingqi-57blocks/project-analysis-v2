/**
 * Audit a report against the knowledge base it claims to have been written from.
 *
 *   pnpm audit:report <reportPath> [--db .analysis/kb.sqlite]
 *
 * The report's own `manifest.json` names the snapshot; this re-resolves it from
 * the base and refuses if the two disagree.
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

import { requiredChecklistIds } from "../engine/contracts/report/checklist.js";
import { auditReport, explainAudit, readInventory, resolveIdentities } from "../engine/report/kb-audit.js";
import { identityNamespaces } from "../engine/report/claims.js";
import { reportReadiness } from "../engine/report/readiness.js";
import { codegraphVersionOf, manifestDisagreements, parseManifest } from "../engine/report/manifest.js";
import { resolveSnapshot } from "../engine/kb/query.js";
import { openStoreReadonly } from "../engine/store/open.js";
import { reportRefusals } from "./refusals.js";

reportRefusals();

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
const runDir = dirname(resolve(reportPath));

/**
 * The manifest is required, and required first.
 *
 * A report that names no snapshot cannot be audited against one — only against
 * whichever snapshot the audit picked, which is the defect this replaces. There
 * is no fallback, deliberately: falling back to "the latest" would leave every
 * report written before this change auditable in exactly the wrong way, and a
 * silently-wrong verdict is worse than a refusal.
 */
const manifestPath = `${runDir}/manifest.json`;
if (!existsSync(manifestPath)) {
  console.error(
    `no manifest.json beside the report.\n` +
      `A report is audited against the snapshot it names, not against whatever the base holds last.\n` +
      `Write ${manifestPath} first — the shape is in skills/project-report/references/reading-the-kb.md.`,
  );
  process.exit(2);
}

const store = openStoreReadonly(dbPath);
const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
// Resolves by run id and only among published snapshots, so a run that failed
// before publishing cannot be audited as though it had succeeded.
const snapshot = resolveSnapshot(store, manifest.runId);
const disagreements = manifestDisagreements(manifest, {
  ...snapshot,
  codegraphVersion: codegraphVersionOf(store, snapshot.id),
});
if (disagreements.length > 0) {
  console.error(
    `manifest.json disagrees with the knowledge base:\n` +
      disagreements.map((line) => `  ${line}`).join("\n") +
      `\nThe report was written from something other than what it names, or the base was rebuilt since.`,
  );
  store.close();
  process.exit(2);
}

const rootCount =
  store.get<{ n: number }>("select count(*) as n from source_roots where snapshot_id = ?", [snapshot.id])?.n ?? 1;
const report = readFileSync(resolve(reportPath), "utf8");
const checklistPath = `${runDir}/checklist.json`;
const claimsPath = `${runDir}/claims.json`;
const logPath = `${runDir}/queries.log`;
const result = auditReport({
  report,
  inventory: readInventory(store, snapshot.id),
  requiredChecklistIds: requiredChecklistIds(rootCount),
  ...(existsSync(checklistPath) ? { checklist: readFileSync(checklistPath, "utf8") } : {}),
  ...(existsSync(claimsPath) ? { claims: readFileSync(claimsPath, "utf8") } : {}),
  ...(existsSync(logPath) ? { queriesLog: readFileSync(logPath, "utf8") } : {}),
  requireQueriesLog: true,
  readiness: reportReadiness(store, snapshot.id, manifest.specId),
  namespaces: identityNamespaces(store, snapshot.id),
  resolveIds: (ids) => resolveIdentities(store, snapshot.id, ids),
});

const verdictPath = `${runDir}/audit.json`;
writeFileSync(
  verdictPath,
  JSON.stringify(
    {
      report: resolve(reportPath),
      snapshotId: snapshot.id,
      runId: snapshot.runId,
      identity: snapshot.identity,
      workspacePath: snapshot.workspacePath,
      passed: result.passed,
      findings: result.findings,
      checklist: result.checklist,
    },
    null,
    2,
  ) + "\n",
);

console.log(explainAudit(result));
console.log(`verdict → ${verdictPath}`);
store.close();
if (!result.passed) process.exit(1);
