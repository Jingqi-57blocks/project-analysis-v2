/**
 * Run the WCP-V2 behaviour truth gate (PI-67) over a derived behaviour model and
 * write the report to .analysis/. Writes only to .analysis.
 *
 *   tsx scripts/run-behavior-gate.ts [modelJson] [rootName] [out]
 *
 * `modelJson` is a serialized BehaviorModel — the integrated model PI-13 assembles
 * from the PI-11/PI-12 derivers. With no model, it grades against an empty model,
 * which honestly reports every behaviour item as not-found rather than a false pass.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { itemsForFacet, loadLeaveTruthLedger } from "../engine/contracts/truth/leave.js";
import { gradeBehaviorTruth } from "../engine/gates/behavior-truth.js";
import type { BehaviorModel } from "../engine/contracts/behavior/schema.js";

const modelJson = process.argv[2];
const rootName = process.argv[3] ?? "wcp-service-v2";
const out = process.argv[4] ?? ".analysis/behavior-gate.json";

const model: BehaviorModel =
  modelJson === undefined || modelJson === "-"
    ? { schemaVersion: "1.0.0", facts: [], relations: [] }
    : (JSON.parse(readFileSync(modelJson, "utf8")) as BehaviorModel);

const m2 = itemsForFacet(loadLeaveTruthLedger(), "M2");
const report = gradeBehaviorTruth(m2, model, rootName);

mkdirSync(".analysis", { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Behaviour truth gate over ${rootName}: ${report.mustFindFound}/${report.mustFindTotal} behaviour-lane must-find found; ` +
    `denominator ${report.denominator}; ${report.criticalIssues} critical issues; ownership-disjoint=${report.ownershipDisjoint}; passed=${report.passed}`,
);
console.log(`model: ${model.facts.length} facts; report -> ${out}`);
for (const r of report.results) {
  console.log(`  ${r.truthId} [${r.category}/${r.lane}/${r.criticality}] ${r.status} — ${r.detail}`);
}
