/**
 * Run the no-dedicated-reader structural smoke gate (PI-66) over a CodeGraph
 * index of an angels-pizza root and write the report to .analysis/.
 *
 *   tsx scripts/run-smoke-gate.ts <indexDir> [rootName] [out]
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { loadAngelsPizzaSentinels } from "../engine/contracts/truth/sentinel.js";
import { gradeSentinels } from "../engine/gates/sentinel-smoke.js";
import { codeIndexDbPath, readBatchDb } from "../engine/providers/codegraph/batchdb.js";
import { importEdges } from "../engine/providers/codegraph/importedges.js";
import { importNodes } from "../engine/providers/codegraph/importnodes.js";

const indexDir = process.argv[2];
const rootName = process.argv[3] ?? "web-vue";
const out = process.argv[4] ?? ".analysis/smoke-gate.json";

if (indexDir === undefined) {
  console.error("usage: run-smoke-gate <indexDir> [rootName] [out]");
  process.exit(2);
}

const outcome = readBatchDb(codeIndexDbPath(indexDir), indexDir);
if (!outcome.ok) {
  console.error("CodeGraph index read failed:", JSON.stringify(outcome.degradation));
  process.exit(1);
}

const nodes = importNodes(outcome.snapshot).nodes;
const edges = importEdges(outcome.snapshot).edges;
const report = gradeSentinels(loadAngelsPizzaSentinels().items, nodes, edges, rootName);

mkdirSync(".analysis", { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Smoke gate over ${rootName}: ${nodes.length} nodes; positives ${report.positivesFound}/${report.positivesTotal}; clean-absences ${report.cleanAbsencesHonored}/${report.cleanAbsencesTotal}; passed=${report.passed}`,
);
console.log(`report -> ${out}`);
for (const r of report.results) console.log(`  ${r.id} [${r.kind}] ${r.status} — ${r.detail}`);
