/**
 * Run the WCP-V2 leave fresh baseline (PI-19) and write it to .analysis/.
 *
 *   tsx scripts/run-fresh-baseline.ts [workspacePath] [out]
 *
 * It runs a fresh analysis of the leave golden-slice root (no reuse or resume of a
 * prior run), grades the truth ledger through the structural (PI-65), behaviour
 * (PI-67) and report (PI-68) gates over that one snapshot, and folds the three
 * receipts into one baseline with a per-item disposition, a responsibility layer
 * and a machine-readable gap ledger. It requests the leave module product +
 * developer reports module-only and records the project-level footprint as zero.
 *
 * Writes only to .analysis. It measures and attributes; it fixes nothing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runAnalyze } from "../engine/run/analyze.js";
import { openStore } from "../engine/store/open.js";
import { readBehaviorModel } from "../engine/kb/behavior-persist.js";
import { readBatchDb } from "../engine/providers/codegraph/batchdb.js";
import { importNodes } from "../engine/providers/codegraph/importnodes.js";
import { importEdges } from "../engine/providers/codegraph/importedges.js";
import { itemsForFacet, loadLeaveTruthLedger } from "../engine/contracts/truth/leave.js";
import { gradeStructuralTruth } from "../engine/gates/structural-truth.js";
import { gradeBehaviorTruth } from "../engine/gates/behavior-truth.js";
import { gradeReportTruth } from "../engine/gates/report-truth.js";
import { aggregateFreshBaseline, type RunManifest } from "../engine/gates/fresh-baseline.js";
import { compileExecutablePlan } from "../engine/report/plan.js";
import { projectLevelFootprint, verifyDedup } from "../engine/report/combination.js";
import { moduleTarget } from "../engine/contracts/report/target.js";
import { authoredTasks, type GenerationParams } from "../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../engine/contracts/report/snapshot.js";

const WORKSPACE = resolve(process.argv[2] ?? resolve(homedir(), "Documents/WCP-V2"));
const ROOT = "wcp-service-v2";
const MODULE = "leave";
const out = process.argv[3] ?? ".analysis/fresh-baseline.json";
const dbPath = resolve(".analysis/kb.sqlite");

// 1. Fresh analysis of the golden-slice root — no reuse of a prior run. The index
// is rooted at the root itself (indexRoot = the root), so every code-index path is
// relative to it (internal/...), which is what the truth citations are relative to.
// Rooting at the workspace parent would prefix every path with the root name and no
// citation would match.
const rootPath = resolve(WORKSPACE, ROOT);
const analysis = runAnalyze({ paths: [rootPath], indexRoot: rootPath, dbPath });

// 2. Structural gate over the fresh per-root code index.
const indexOutcome = readBatchDb(resolve(rootPath, ".codegraph/codegraph.db"), rootPath);
if (!indexOutcome.ok) {
  console.error("CodeGraph index read failed:", JSON.stringify(indexOutcome.degradation));
  process.exit(1);
}
const nodes = importNodes(indexOutcome.snapshot).nodes;
const edges = importEdges(indexOutcome.snapshot).edges;
const ledger = loadLeaveTruthLedger();
const structural = gradeStructuralTruth(itemsForFacet(ledger, "M1"), nodes, edges, ROOT);

// 3. Behaviour gate over the model derived into the fresh knowledge base.
const store = openStore(dbPath);
const model = readBehaviorModel(store, analysis.snapshotId);
const behavior = gradeBehaviorTruth(itemsForFacet(ledger, "M2"), model, ROOT);

// 4. Report gate over the module-only leave product + developer plan.
const snapshot: AnalysisSnapshotIdentity = {
  sourceIdentity: analysis.identity,
  codeGraphIdentity: analysis.identity,
  providerIdentity: analysis.identity,
  schemaVersion: "1.0.0",
  configIdentity: analysis.identity,
};
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-m4", language: "en" };
const request = [moduleTarget(MODULE, "product"), moduleTarget(MODULE, "developer")];
const executable = compileExecutablePlan({ request, snapshot, params, analysisRunId: analysis.runId });
const validatedTaskIds = new Set(authoredTasks(executable.plan).map((t) => t.taskId));
const report = gradeReportTruth(itemsForFacet(ledger, "M3"), executable, validatedTaskIds, MODULE);
const footprint = projectLevelFootprint(executable);
const dedup = verifyDedup(request, executable);

// 5. Aggregate the three receipts into one baseline.
const manifest: RunManifest = {
  snapshotIdentity: analysis.identity,
  analysisSnapshotId: analysis.snapshotId,
  behaviorSnapshotId: analysis.snapshotId, // the snapshot the behaviour model was read from
  codeIndexNodeCount: nodes.length,
  truthVersion: ledger.manifest.version,
  pipelineVersion: "1.0.0",
  structuralRoot: ROOT,
  rootRevisions: analysis.roots.map((r) => ({ name: r.name, commitSha: r.commitSha, dirty: r.dirty === true })),
  reportDocuments: [...executable.plan.documents.map((d) => d.documentId)].sort(),
  // A real check: the structural gate read a populated index, the behaviour model
  // came from this run's KB snapshot, and the report request materialized without a
  // dedup/scope violation. Not vacuously true — a stale/empty index or a dedup
  // failure flips it.
  gatesGradedThisRun: nodes.length > 0 && behavior.indexedRoot === ROOT && dedup.ok,
};
if (!dedup.ok) console.error("report request dedup/scope violation:", JSON.stringify(dedup.violations));

const baseline = aggregateFreshBaseline({
  truthItems: ledger.items,
  structural,
  behavior,
  report,
  manifest,
  projectLevelDocuments: footprint.projectDocumentCount,
  projectLevelTasks: footprint.projectTaskCount,
});

mkdirSync(".analysis", { recursive: true });
writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);

const c = baseline.counts;
console.log(
  `Fresh baseline over ${ROOT} (snapshot ${analysis.identity.slice(0, 12)}): ${baseline.total} items — ` +
    `observed ${c.observed}, printed ${c.printed}, counted ${c.counted}, unresolved ${c.unresolved}, ` +
    `missing ${c.missing}, wrong ${c.wrong}, not-applicable ${c["not-applicable"]}, provider-failure ${c["provider-failure"]}, unsupported ${c.unsupported}`,
);
const cov = baseline.coverage;
console.log(
  `coverage — structural must-find ${cov.structuralMustFind[0]}/${cov.structuralMustFind[1]}, ` +
    `behaviour must-find ${cov.behaviorMustFind[0]}/${cov.behaviorMustFind[1]}, report must-print ${cov.reportMustPrint[0]}/${cov.reportMustPrint[1]}`,
);
console.log(
  `gaps ${baseline.gapLedger.length}; project-level docs ${baseline.projectLevelDocuments}, tasks ${baseline.projectLevelTasks}; ` +
    `gates graded this run ${baseline.manifest.gatesGradedThisRun}; well-formed ${baseline.wellFormed}; golden-slice passed ${baseline.goldenSlicePassed}`,
);
console.log(`report -> ${out}`);
for (const g of baseline.gapLedger.slice(0, 25)) console.log(`  gap ${g.truthId} [${g.criticality}] ${g.disposition} @ ${g.layer} — ${g.detail}`);
if (baseline.gapLedger.length > 25) console.log(`  … ${baseline.gapLedger.length - 25} more`);
