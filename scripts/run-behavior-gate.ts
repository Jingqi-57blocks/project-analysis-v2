/**
 * Run the WCP-V2 behaviour truth gate (PI-67) over a derived behaviour model and
 * write the report to .analysis/. Writes only to .analysis.
 *
 *   tsx scripts/run-behavior-gate.ts [modelJson] [rootName] [out]
 *   tsx scripts/run-behavior-gate.ts --db <kb.sqlite> [--snapshot <id>] [--root <name>] [--out <path>]
 *
 * Two ways to name the model. A serialized `modelJson` is the integrated model
 * PI-13 assembles from the PI-11/PI-12 derivers; with none, it grades an empty
 * model, which honestly reports every behaviour item as not-found rather than a
 * false pass — and, having no persisted receipt, uses test-coverage "not-run"
 * (fail closed).
 *
 * Given `--db`, it reads the model AND the persisted test-coverage receipt for the
 * snapshot (the fact-less `behavior_diagnostics` row `test-coverage: covered|not-run`
 * that a full analysis writes), so it grades the SAME snapshot the fresh baseline
 * did with the SAME coverage — a test-relation absence is not withheld here while
 * the baseline certifies it. An older snapshot with no such row defaults to
 * "not-run" (fail closed).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { itemsForFacet, loadLeaveTruthLedger } from "../engine/contracts/truth/leave.js";
import { gradeBehaviorTruth } from "../engine/gates/behavior-truth.js";
import { openStore } from "../engine/store/open.js";
import { readBehaviorDiagnostics, readBehaviorModel } from "../engine/kb/behavior-persist.js";
import type { BehaviorModel } from "../engine/contracts/behavior/schema.js";
import type { TestCoverage } from "../engine/kb/test-derive.js";
import type { Store } from "../engine/store/types.js";

const COVERAGE_PREFIX = "test-coverage: ";

/** The persisted coverage receipt for a snapshot, or "not-run" when none was written. */
function persistedCoverage(store: Store, snapshotId: number): TestCoverage {
  for (const d of readBehaviorDiagnostics(store, snapshotId)) {
    if (d.factId !== null || !d.reason.startsWith(COVERAGE_PREFIX)) continue;
    const value = d.reason.slice(COVERAGE_PREFIX.length).trim();
    if (value === "covered" || value === "not-run") return value;
  }
  return "not-run";
}

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token.startsWith("--")) {
    flags.set(token, argv[i + 1] ?? "");
    i++;
  } else {
    positional.push(token);
  }
}

const dbPath = flags.get("--db");
// Legacy positional form is [modelJson] [rootName] [out]; --db mode has no
// modelJson positional, so root/out shift left by one. Flags win over positions.
const modelJson = dbPath === undefined ? positional[0] : undefined;
const rootName = flags.get("--root") ?? (dbPath === undefined ? positional[1] : positional[0]) ?? "wcp-service-v2";
const out = flags.get("--out") ?? (dbPath === undefined ? positional[2] : positional[1]) ?? ".analysis/behavior-gate.json";

let model: BehaviorModel;
let coverage: TestCoverage;
let source: string;

if (dbPath !== undefined) {
  const store = openStore(resolve(dbPath));
  const snapshotFlag = flags.get("--snapshot");
  const snapshotId =
    snapshotFlag !== undefined
      ? Number(snapshotFlag)
      : store.get<{ id: number }>(
          "SELECT id FROM snapshots WHERE published_at IS NOT NULL ORDER BY id DESC LIMIT 1",
          [],
        )?.id;
  if (snapshotId === undefined || Number.isNaN(snapshotId)) {
    console.error(`no published snapshot in ${dbPath}${snapshotFlag !== undefined ? ` (--snapshot ${snapshotFlag})` : ""}`);
    process.exit(1);
  }
  model = readBehaviorModel(store, snapshotId);
  coverage = persistedCoverage(store, snapshotId);
  store.close();
  source = `db ${dbPath} snapshot ${snapshotId}`;
} else {
  model =
    modelJson === undefined || modelJson === "-"
      ? { schemaVersion: "1.0.0", facts: [], relations: [] }
      : (JSON.parse(readFileSync(modelJson, "utf8")) as BehaviorModel);
  // A standalone model over arbitrary JSON carries no receipt that the reader ran,
  // so a test-relation absence fails closed.
  coverage = "not-run";
  source = modelJson === undefined || modelJson === "-" ? "empty model" : `model ${modelJson}`;
}

const m2 = itemsForFacet(loadLeaveTruthLedger(), "M2");
const report = gradeBehaviorTruth(m2, model, rootName, coverage);

mkdirSync(".analysis", { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Behaviour truth gate over ${rootName}: ${report.mustFindFound}/${report.mustFindTotal} behaviour-lane must-find found; ` +
    `denominator ${report.denominator}; ${report.criticalIssues} critical issues; ownership-disjoint=${report.ownershipDisjoint}; passed=${report.passed}`,
);
console.log(`source: ${source}; test-coverage ${coverage}; ${model.facts.length} facts; report -> ${out}`);
for (const r of report.results) {
  console.log(`  ${r.truthId} [${r.category}/${r.lane}/${r.criticality}] ${r.status} — ${r.detail}`);
}
