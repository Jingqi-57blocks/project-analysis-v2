/**
 * angels-pizza cross-project acceptance baseline (PI-25).
 *
 *   tsx scripts/run-angels-baseline.ts [workspacePath] [out]
 *
 * A FRESH, generic-only run of the analyzer over the angels-pizza sentinel roots
 * (backend + web-vue) plus one module-report root (admin-backend), mirroring
 * scripts/run-fresh-baseline.ts's per-root `runAnalyze({paths:[rootPath],
 * indexRoot: rootPath, dbPath})`. angels has no leave-style truth ledger, so it
 * grades STRUCTURE via the frozen PI-77 sentinels (loadAngelsPizzaSentinels +
 * gradeSentinels), and reports what the generic derivers extracted per root.
 *
 * It adds NO angels-pizza literal/config/prompt: it only names roots on the CLI
 * and reads the human-owned truth-set. Writes only to .analysis.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runAnalyze } from "../engine/run/analyze.js";
import { openStore } from "../engine/store/open.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { queryBehaviorFacts } from "../engine/kb/behavior-query.js";
import { readBatchDb } from "../engine/providers/codegraph/batchdb.js";
import { importNodes } from "../engine/providers/codegraph/importnodes.js";
import { importEdges } from "../engine/providers/codegraph/importedges.js";
import { loadAngelsPizzaSentinels, validateSentinelLedger } from "../engine/contracts/truth/sentinel.js";
import { gradeSentinels, type SentinelResult } from "../engine/gates/sentinel-smoke.js";

const WORKSPACE = resolve(process.argv[2] ?? resolve(homedir(), "Documents/angels-pizza"));
const out = process.argv[3] ?? ".analysis/angels-baseline.json";
const ROOTS = ["backend", "web-vue", "admin-backend"];

const BEHAVIOR_KINDS = [
  "decision",
  "guard",
  "condition",
  "validation-rule",
  "state",
  "transition",
  "data-access",
  "outbound-call",
  "notification-call",
  "test-relation",
  "auth-annotation",
  "error-handling",
  "discarded-error",
  "business-rule",
  "transaction-boundary",
  "value-set",
] as const;

mkdirSync(".analysis", { recursive: true });

const ledger = loadAngelsPizzaSentinels();
const ledgerValidation = validateSentinelLedger(ledger);

interface RootReport {
  root: string;
  contentIdentity: string;
  snapshotId: number;
  testCoverage: string;
  codegraph: { nodes: number; edges: number; byStructuralKind: Record<string, number>; routeNodes: number };
  structural: {
    modules: { count: number; names: string[] };
    features: number;
    serverRoutes: number;
    clientRoutes: number;
    entities: number;
    dataAccessStructural: number;
    crossRootLinks: number;
    unlinkedCalls: number;
    mapEdges: number;
    valueSets: number;
    businessRules: number;
    scheduledTasks: number;
    notificationCallsStructural: number;
  };
  behaviorFacts: Record<string, number>;
  sentinelResults: SentinelResult[];
}

const rootReports: RootReport[] = [];
// Every resolved sentinel result, keyed by sentinel id (each sentinel maps to one root).
const resolvedById = new Map<string, SentinelResult>();

for (const root of ROOTS) {
  const rootPath = resolve(WORKSPACE, root);
  const dbPath = resolve(".analysis", `angels-${root}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });

  const analysis = runAnalyze({ paths: [rootPath], indexRoot: rootPath, dbPath });

  // Code index for this root — the generic CodeGraph path the sentinels ride.
  const indexOutcome = readBatchDb(resolve(rootPath, ".codegraph/codegraph.db"), rootPath);
  if (!indexOutcome.ok) {
    console.error(`[${root}] CodeGraph index read failed:`, JSON.stringify(indexOutcome.degradation));
    process.exit(1);
  }
  const nodes = importNodes(indexOutcome.snapshot).nodes;
  const edges = importEdges(indexOutcome.snapshot).edges;
  const byKind: Record<string, number> = {};
  for (const n of nodes) byKind[n.structuralKind] = (byKind[n.structuralKind] ?? 0) + 1;

  const sentinelReport = gradeSentinels(ledger.items, nodes, edges, root);
  for (const r of sentinelReport.results) {
    if (r.status !== "unresolved") resolvedById.set(r.id, r);
  }

  const store = openStore(dbPath);
  const kb = openKnowledgeBase(store, analysis.runId);

  const behaviorFacts: Record<string, number> = {};
  for (const kind of BEHAVIOR_KINDS) {
    behaviorFacts[kind] = queryBehaviorFacts(store, analysis.snapshotId, { kind }).total;
  }

  rootReports.push({
    root,
    contentIdentity: analysis.identity,
    snapshotId: analysis.snapshotId,
    testCoverage: analysis.testCoverage,
    codegraph: {
      nodes: nodes.length,
      edges: edges.length,
      byStructuralKind: byKind,
      routeNodes: nodes.filter((n) => n.structuralKind === "route").length,
    },
    structural: {
      modules: { count: kb.modules().length, names: kb.modules().map((m) => m.name).sort() },
      features: kb.features().length,
      serverRoutes: kb.endpoints().length,
      clientRoutes: kb.screens().length,
      entities: kb.entities().length,
      dataAccessStructural: kb.dataAccess().length,
      crossRootLinks: kb.crossRootLinks().length,
      unlinkedCalls: kb.unlinkedCalls().length,
      mapEdges: kb.mapEdges().length,
      valueSets: kb.valueSets().length,
      businessRules: kb.businessRules().length,
      scheduledTasks: kb.scheduledTasks().length,
      notificationCallsStructural: kb.notificationCalls().length,
    },
    behaviorFacts,
    sentinelResults: sentinelReport.results.filter((r) => r.status !== "unresolved"),
  });

  const last = rootReports[rootReports.length - 1]!;
  console.log(
    `[${root}] identity ${analysis.identity.slice(0, 12)} nodes=${nodes.length} modules=${last.structural.modules.count} ` +
      `serverRoutes=${last.structural.serverRoutes} clientRoutes=${last.structural.clientRoutes} testCoverage=${analysis.testCoverage}`,
  );
  store.close();
}

// --- Per-sentinel disposition: found / wrong / missing / unresolved --------------
type Disposition = "found" | "wrong" | "missing" | "unresolved";
function disposition(item: (typeof ledger.items)[number], result: SentinelResult | undefined): Disposition {
  if (result === undefined) return "unresolved";
  if (item.kind === "clean-absence") return result.status === "absent" ? "found" : "wrong";
  // positive / negative: graded by whether the cited structure was produced.
  if (result.status === "found") return "found";
  if (result.status === "not-found") return "missing";
  return "unresolved";
}

const sentinelGrading = ledger.items.map((item) => {
  const result = resolvedById.get(item.id);
  return {
    id: item.id,
    root: item.root,
    kind: item.kind,
    category: item.category,
    criticality: item.criticality,
    mustFind: item.mustFind,
    noDedicatedReader: item.noDedicatedReader,
    claim: item.claim,
    prevents: item.prevents,
    gateStatus: result?.status ?? "unresolved",
    disposition: disposition(item, result),
    detail: result?.detail ?? "sentinel root was not analyzed in this run",
  };
});

const counts = { found: 0, wrong: 0, missing: 0, unresolved: 0 };
for (const g of sentinelGrading) counts[g.disposition] += 1;

// Precision cross-check: the no-reader Vue root must carry NO server-side routes.
const webVue = rootReports.find((r) => r.root === "web-vue");
const precision = {
  webVueServerRoutes: webVue?.structural.serverRoutes ?? null,
  webVueRouteNodes: webVue?.codegraph.routeNodes ?? null,
  webVueClientRoutes: webVue?.structural.clientRoutes ?? null,
  cleanAbsenceHonored: (webVue?.structural.serverRoutes ?? 0) === 0 && (webVue?.codegraph.routeNodes ?? 0) === 0,
  note: "AP-WEBVUE-NEG-01 / AP-WEBVUE-ABS-01 hold only if the Vue SPA produced zero server-side route facts.",
};

const mustFindMissing = sentinelGrading.filter((g) => g.mustFind && (g.disposition === "missing" || g.disposition === "wrong"));

const baseline = {
  target: "angels-pizza",
  workspace: WORKSPACE,
  truthVersion: ledger.manifest.version,
  ledgerValidation,
  analyzedRoots: ROOTS,
  generatedAt: new Date().toISOString(),
  sentinelGrading,
  counts,
  mustFindMissing,
  precision,
  passed:
    ledgerValidation.ok &&
    counts.wrong === 0 &&
    mustFindMissing.length === 0 &&
    counts.unresolved === 0 &&
    precision.cleanAbsenceHonored,
  rootReports,
};

writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);

console.log(`\nangels-pizza baseline (truth ${ledger.manifest.version}, ledger valid=${ledgerValidation.ok})`);
console.log(`  sentinels: found ${counts.found}, wrong ${counts.wrong}, missing ${counts.missing}, unresolved ${counts.unresolved}`);
for (const g of sentinelGrading) console.log(`    ${g.id} [${g.kind}/${g.root}] ${g.disposition} (${g.gateStatus}) — ${g.detail}`);
console.log(`  precision: web-vue serverRoutes=${precision.webVueServerRoutes} routeNodes=${precision.webVueRouteNodes} clientRoutes=${precision.webVueClientRoutes} cleanAbsenceHonored=${precision.cleanAbsenceHonored}`);
console.log(`  PASSED=${baseline.passed}`);
console.log(`  -> ${out}`);
