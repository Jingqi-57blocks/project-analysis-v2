/**
 * Run the WCP-V2 structural truth gate (PI-65) over a CodeGraph index and write
 * the report to .analysis/. Reads the index read-only; writes only to .analysis.
 *
 *   tsx scripts/run-structural-gate.ts <indexDir> [rootName] [out]
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { itemsForFacet, loadLeaveTruthLedger } from "../engine/contracts/truth/leave.js";
import { gradeStructuralTruth } from "../engine/gates/structural-truth.js";
import { codeIndexDbPath, readBatchDb } from "../engine/providers/codegraph/batchdb.js";
import { importEdges } from "../engine/providers/codegraph/importedges.js";
import { importNodes } from "../engine/providers/codegraph/importnodes.js";

const indexDir = process.argv[2];
const rootName = process.argv[3] ?? "wcp-service-v2";
const out = process.argv[4] ?? ".analysis/structural-gate.json";

if (indexDir === undefined) {
  console.error("usage: run-structural-gate <indexDir> [rootName] [out]");
  process.exit(2);
}

const outcome = readBatchDb(codeIndexDbPath(indexDir), indexDir);
if (!outcome.ok) {
  console.error("CodeGraph index read failed:", JSON.stringify(outcome.degradation));
  process.exit(1);
}

const nodes = importNodes(outcome.snapshot).nodes;
const edges = importEdges(outcome.snapshot).edges;
const m1 = itemsForFacet(loadLeaveTruthLedger(), "M1");
const report = gradeStructuralTruth(m1, nodes, edges, rootName);

mkdirSync(".analysis", { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Structural truth gate over ${rootName}: ${report.mustFindFound}/${report.mustFindTotal} CodeGraph-lane must-find found; ${report.criticalIssues} critical issues; passed=${report.passed}`,
);
console.log(`snapshot: ${nodes.length} nodes, ${edges.length} edges; report -> ${out}`);
for (const r of report.results) {
  console.log(`  ${r.truthId} [${r.category}/${r.criticality}] ${r.status} — ${r.detail}`);
}
