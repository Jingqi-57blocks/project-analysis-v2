/**
 * Run the WCP-V2 report truth gate (PI-68) over the compiled leave module reports
 * and write the report to .analysis/. Writes only to .analysis.
 *
 *   tsx scripts/run-report-gate.ts [moduleId] [out]
 *
 * It compiles the leave module's product and developer documents from the section
 * catalog and grades the facet=M3 truth items against that plan: whether each
 * item's fact is routed into the section of the report its required scope × audience
 * names, with its blocks accounted.
 *
 * This grades the compiled plan's routing and structural block accounting — the M3
 * contract. The authored blocks are treated as present (the plan compiled them);
 * substituting a real Host Agent's per-block validation outcomes is the M4 fresh
 * run (PI-19), which reuses this same gate with the executed `validatedTaskIds`.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { itemsForFacet, loadLeaveTruthLedger } from "../engine/contracts/truth/leave.js";
import { authoredTasks, type GenerationParams } from "../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../engine/contracts/report/snapshot.js";
import { moduleTarget } from "../engine/contracts/report/target.js";
import { compileExecutablePlan } from "../engine/report/plan.js";
import { gradeReportTruth } from "../engine/gates/report-truth.js";

const moduleId = process.argv[2] ?? "leave";
const out = process.argv[3] ?? ".analysis/report-gate.json";

// A frozen analysis snapshot — the gate grades the plan's routing, not source, so
// the snapshot identity only has to be stable, not a live index.
const snapshot: AnalysisSnapshotIdentity = {
  sourceIdentity: "wcp-v2-leave",
  codeGraphIdentity: "m3-report-gate",
  providerIdentity: "m3-report-gate",
  schemaVersion: "1.0.0",
  configIdentity: "m3-report-gate",
};
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-m3", language: "en" };

const executable = compileExecutablePlan({
  request: [moduleTarget(moduleId, "product"), moduleTarget(moduleId, "developer")],
  snapshot,
  params,
  analysisRunId: "m3-report-gate",
});

// M3: the compiled plan's authored blocks are present; the M4 fresh run substitutes
// real validation outcomes here.
const validatedTaskIds = new Set(authoredTasks(executable.plan).map((t) => t.taskId));

const m3 = itemsForFacet(loadLeaveTruthLedger(), "M3");
const report = gradeReportTruth(m3, executable, validatedTaskIds, moduleId);

mkdirSync(".analysis", { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Report truth gate over ${moduleId} (${report.documentIds.join(", ")}): ` +
    `${report.mustPrintPrinted}/${report.mustPrintTotal} must-print printed; ` +
    `${report.criticalIssues} critical issues; slice-out ${report.sliceOutClaims}; ` +
    `cross-report conflicts ${report.crossReportConflicts}; passed=${report.passed}`,
);
console.log(`report -> ${out}`);
for (const r of report.results) {
  console.log(`  ${r.truthId} [${r.category}/${r.criticality}${r.mustPrint ? "/must-print" : ""}] ${r.status} — ${r.detail}`);
}
