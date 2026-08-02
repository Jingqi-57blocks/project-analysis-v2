/**
 * Deterministic, SOURCE-REPRODUCIBLE acceptance of the WCP-V2 leave dual detail
 * reports (PI-21 product + PI-22 developer + PI-23 source audit).
 *
 *   tsx scripts/accept-pi-21-23.ts [workspacePath]
 *
 * It runs its OWN fresh, deterministic per-root analysis of the leave golden-slice
 * root into a dedicated database (never the shared .analysis/kb.sqlite, and never
 * "the latest published snapshot", either of which could silently retarget), then
 * compiles the leave module product + developer plan with REAL per-kind coverage
 * from the slice resolver, executes the authored tasks through the deterministic
 * (model-free) Host Agent, and produces the dual report plus a machine-readable
 * audit. Every digest is keyed off the analysis CONTENT identity, not the run's
 * random run id, so two machines analysing the same frozen source reach identical
 * digests, audit and reports — reproducible from source, not from one KB file.
 *
 * It calls no model — the LLM prose is deferred and recorded as open, never faked.
 * Writes only to .analysis: a dedicated KB, the two rendered reports and one
 * acceptance JSON.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runAnalyze } from "../engine/run/analyze.js";
import { openStore } from "../engine/store/open.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { readBehaviorModel } from "../engine/kb/behavior-persist.js";
import { compileExecutablePlan } from "../engine/report/plan.js";
import { produceDualReport } from "../engine/report/dual-report.js";
import { executeAuthoredTasks } from "../engine/report/execute.js";
import { projectLevelFootprint, verifyDedup } from "../engine/report/combination.js";
import { gradeReportTruth } from "../engine/gates/report-truth.js";
import { gradeBehaviorTruth } from "../engine/gates/behavior-truth.js";
import { itemsForFacet, loadLeaveTruthLedger } from "../engine/contracts/truth/leave.js";
import { type ReportTarget, type Scope, moduleTarget, targetKey } from "../engine/contracts/report/target.js";
import { type SectionDefinition, sectionById } from "../engine/contracts/report/catalog.js";
import { type AuthoredBlockTask, authoredTasks, type GenerationParams } from "../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../engine/contracts/report/snapshot.js";
import type { KindCoverageInput, SectionApplicabilityDecision } from "../engine/report/applicability.js";
import { PM_QUESTIONS, pmQuestionCoverage, validatePmPreset } from "../engine/report/presets/pm.js";
import { DEV_QUESTIONS, devQuestionCoverage, validateDevPreset } from "../engine/report/presets/dev.js";
import {
  coverageInputForKind,
  createSliceReaders,
  resolveKindCoverage,
  resolveModuleMembership,
  resolveSliceFacts,
} from "../engine/report/slice-resolve.js";
import { type DecisionIndex, deterministicContent } from "../engine/report/deterministic-content.js";
import { deterministicHost } from "../engine/report/deterministic-host.js";

const MODULE = "leave";
const ROOT = "wcp-service-v2";
const outDir = ".analysis";
const WORKSPACE = resolve(process.argv[2] ?? resolve(homedir(), "Documents/WCP-V2"));
const rootPath = resolve(WORKSPACE, ROOT);
// A dedicated KB, rebuilt fresh each run so the acceptance can never collide with
// or retarget the shared .analysis/kb.sqlite.
const dbPath = resolve(outDir, "pi21-accept.sqlite");

// --- 1. Fresh, deterministic per-root analysis pinned to THIS run's snapshot -----
// The index is rooted at the root itself so every code-index path is relative to
// it (internal/...) — the same rooting the truth citations use.
mkdirSync(outDir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
const analysis = runAnalyze({ paths: [rootPath], indexRoot: rootPath, dbPath });

const store = openStore(dbPath);
const kb = openKnowledgeBase(store, analysis.runId);
const membership = resolveModuleMembership(kb, MODULE);
const readers = createSliceReaders(store, analysis.snapshotId, membership);

// Every identity dimension is the analysis CONTENT identity (a content digest that
// is equal for two runs over unchanged source), never the per-run random run id —
// so the plan, audit, execution and render digests are functions of the source.
const snapshotIdentity: AnalysisSnapshotIdentity = {
  sourceIdentity: analysis.identity,
  codeGraphIdentity: analysis.identity,
  providerIdentity: analysis.identity,
  schemaVersion: "1.0.0",
  configIdentity: analysis.identity,
};
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-pi21", language: "en" };
const analysisRunId = analysis.identity;
const request: readonly ReportTarget[] = [moduleTarget(MODULE, "product"), moduleTarget(MODULE, "developer")];
const moduleScope: Scope = moduleTarget(MODULE, "product").scope;

// --- 2. Real per-kind coverage, so applicability is honest (not vacuously in) ----
function realCoverage(target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] {
  return section.inputFactKinds.map((kind) => ({
    kind,
    coverage: coverageInputForKind(resolveKindCoverage(readers, target.scope, kind)),
  }));
}

function decisionIndex(applicability: readonly { documentId: string; decision: SectionApplicabilityDecision }[]): DecisionIndex {
  const index = new Map<string, Map<string, SectionApplicabilityDecision>>();
  for (const { documentId, decision } of applicability) {
    let inner = index.get(documentId);
    if (inner === undefined) {
      inner = new Map();
      index.set(documentId, inner);
    }
    inner.set(decision.sectionId, decision);
  }
  return index;
}

// --- 3. The whole deterministic pipeline, wrapped so it can run twice -----------
function runPipeline() {
  const executable = compileExecutablePlan({ request, snapshot: snapshotIdentity, params, analysisRunId, coverage: realCoverage });
  const decisions = decisionIndex(executable.applicability);
  const content = deterministicContent({ readers, decisions });
  const host = deterministicHost({ readers, decisions });
  const run = executeAuthoredTasks(executable.plan, host);
  const validatedTaskIds = new Set(run.artifacts.filter((a) => a.validated).map((a) => a.taskId));
  const dual = produceDualReport(executable.plan, executable.slices, run.artifacts, content);
  return { executable, decisions, run, validatedTaskIds, dual };
}

const first = runPipeline();
const second = runPipeline();
const { executable, decisions, run, validatedTaskIds, dual } = first;

// --- 4. Determinism — content-keyed digests, byte-identical across two runs ------
const determinism = {
  keyedOff: "analysis content identity (not the run id) — reproducible from source",
  planDigest: executable.plan.planDigest,
  auditDigest: executable.auditDigest,
  executionDigest: run.executionDigest,
  renderedManifestDigest: dual.rendered.manifest.digest,
  secondRun: {
    planDigest: second.executable.plan.planDigest,
    auditDigest: second.executable.auditDigest,
    executionDigest: second.run.executionDigest,
    renderedManifestDigest: second.dual.rendered.manifest.digest,
  },
  equalAcrossTwoRuns:
    executable.plan.planDigest === second.executable.plan.planDigest &&
    executable.auditDigest === second.executable.auditDigest &&
    run.executionDigest === second.run.executionDigest &&
    dual.rendered.manifest.digest === second.dual.rendered.manifest.digest,
};

// --- 5. Question coverage per audience (the FULL required question sets) ---------
interface QuestionCoverageRow {
  readonly questionId: string;
  readonly sectionId: string;
  readonly scope: string;
  readonly applicability: string;
  readonly reason: string;
  readonly boundFactCount: number;
  readonly factIds: readonly string[];
}

function questionCoverageFor(
  questions: readonly { id: string; sectionId: string; scope: string }[],
  statuses: readonly { questionId: string; sectionId: string; applicability: string; reason: string }[],
): { rows: readonly QuestionCoverageRow[]; summary: Record<string, number> } {
  const statusById = new Map(statuses.map((s) => [s.questionId, s] as const));
  const rows: QuestionCoverageRow[] = questions.map((q) => {
    if (q.scope === "project") {
      // A module-only request compiles no project document, so a project-scope
      // question is not-applicable at module scope — disclosed, never a failure.
      return {
        questionId: q.id,
        sectionId: q.sectionId,
        scope: q.scope,
        applicability: "not-applicable(module-scope)",
        reason: "project-scope section is not compiled for a module-only request",
        boundFactCount: 0,
        factIds: [],
      };
    }
    const section = sectionById(q.sectionId);
    const facts = section === undefined ? [] : resolveSliceFacts(readers, moduleScope, section.inputFactKinds);
    const status = statusById.get(q.id);
    return {
      questionId: q.id,
      sectionId: q.sectionId,
      scope: q.scope,
      applicability: status?.applicability ?? "unknown",
      reason: status?.reason ?? "no applicability decision was recorded for this section",
      boundFactCount: facts.length,
      factIds: facts.slice(0, 15).map((f) => f.factId),
    };
  });

  const summary = { includedWithFacts: 0, structuredUnknownOrNa: 0, includedZeroFacts: 0, projectNotApplicable: 0 };
  for (const row of rows) {
    if (row.scope === "project") summary.projectNotApplicable += 1;
    else if (row.applicability === "unknown" || row.applicability === "not-applicable") summary.structuredUnknownOrNa += 1;
    else if (row.boundFactCount >= 1) summary.includedWithFacts += 1;
    else summary.includedZeroFacts += 1;
  }
  return { rows, summary };
}

const productDoc = targetKey(moduleTarget(MODULE, "product"));
const developerDoc = targetKey(moduleTarget(MODULE, "developer"));
const productDecisions = Object.fromEntries(decisions.get(productDoc) ?? new Map());
const developerDecisions = Object.fromEntries(decisions.get(developerDoc) ?? new Map());
const productCoverage = questionCoverageFor(PM_QUESTIONS, pmQuestionCoverage(productDecisions));
const developerCoverage = questionCoverageFor(DEV_QUESTIONS, devQuestionCoverage(developerDecisions));

// --- 6. Must-print accounting via the M3 report truth gate ----------------------
const ledger = loadLeaveTruthLedger();
const reportGrade = gradeReportTruth(itemsForFacet(ledger, "M3"), executable, validatedTaskIds, MODULE);
const notPrinted = reportGrade.results
  .filter((r) => r.status === "missing" || r.status === "unsupported" || r.status === "unknown")
  .map((r) => ({ truthId: r.truthId, category: r.category, status: r.status, reason: r.detail }));

// The gapped authored blocks — an authored block whose own slice resolved no facts
// and whose section carried no not-applicable/unknown decision. Reported explicitly
// so no gap is silent; the block renders as a marked skeleton gap.
const taskById = new Map(authoredTasks(executable.plan).map((t) => [t.taskId, t] as const));
const gappedAuthoredBlocks = run.artifacts
  .filter((a) => !a.validated)
  .map((a) => {
    const task: AuthoredBlockTask | undefined = taskById.get(a.taskId);
    return { blockId: a.blockId, documentId: task?.documentId ?? null, sectionId: task?.sectionId ?? null, ownKinds: task?.factSlice.factKinds ?? [] };
  })
  .sort((x, y) => (`${x.documentId}/${x.blockId}` < `${y.documentId}/${y.blockId}` ? -1 : 1));

// Placement (the section is present) is a weaker fact than printed (present AND its
// required authored blocks validated). Reported apart so neither overstates.
const mustPrintResults = reportGrade.results.filter((r) => r.mustPrint);
const mustPrintSectionPresent = mustPrintResults.filter((r) => r.placements.length > 0 && r.placements.every((p) => p.present)).length;

const mustPrintAccounting = {
  mustPrintTotal: reportGrade.mustPrintTotal,
  mustPrintPrinted: reportGrade.mustPrintPrinted,
  mustPrintSectionPresent,
  criticalIssues: reportGrade.criticalIssues,
  sliceOutClaims: reportGrade.sliceOutClaims,
  crossReportConflicts: reportGrade.crossReportConflicts,
  passed: reportGrade.passed,
  counts: reportGrade.counts,
  note:
    "A must-print item is 'printed' only when its section is present AND every required authored block in it validated (its own slice grounded). The 8 notification items route to module-notifications-data (product): the section is PRESENT and its authored notes block (declaring `outbound-call`) now grounds on the leave module's outbound-call facts — PI-87's generic outbound-integration-sink capture reverse-reaches the S3 SDK sink through the storage wrapper to a leave export handler, so the block validates and the 8 items print. (The SES email send is decoupled via an in-process channel and does not reach a leave handler through the call graph, so leave-scope outbound grounding is S3-only.)",
  assertions: {
    mustPrintAllPrinted: reportGrade.mustPrintPrinted === reportGrade.mustPrintTotal,
    mustPrintAllPlaced: mustPrintSectionPresent === reportGrade.mustPrintTotal,
    criticalIssuesZero: reportGrade.criticalIssues === 0,
    sliceOutClaimsZero: reportGrade.sliceOutClaims === 0,
    crossReportConflictsZero: reportGrade.crossReportConflicts === 0,
  },
  notPrintedItems: notPrinted,
  gappedAuthoredBlocks,
};

// --- 7. Project-level footprint + dedup (module-only ⇒ {0,0}) --------------------
const footprint = projectLevelFootprint(executable);
const dedup = verifyDedup(request, executable);
const projectFootprint = {
  projectDocumentCount: footprint.projectDocumentCount,
  projectTaskCount: footprint.projectTaskCount,
  isZeroZero: footprint.projectDocumentCount === 0 && footprint.projectTaskCount === 0,
  dedup,
};

// --- 8. Target-specialization scan of the engine report layer -------------------
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

interface ScanFinding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly classification: string;
  readonly benign: boolean;
}

function scanForTargetLiterals(): ScanFinding[] {
  const dirs = ["engine/contracts/report", "engine/report/presets", "engine/report/content"];
  const findings: ScanFinding[] = [];
  for (const dir of dirs) {
    for (const file of listTsFiles(resolve(dir))) {
      const rel = file.slice(resolve(".").length + 1);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        const isComment = trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
        const productToken = /\b(payroll|angels|pizza)\b/i.test(line) || /wcp[-_ ]?service/i.test(line);
        const moduleLiteral = /["'](leave|leaves)["']/i.test(line);
        if (!productToken && !moduleLiteral) return;
        const isTargetFixture = rel.endsWith("contracts/report/target.ts");
        let classification: string;
        let benign: boolean;
        if (isTargetFixture) {
          classification = "LEGAL_COMBINATION_EXAMPLES / ILLEGAL_REQUEST_EXAMPLES test fixture — not consumed by compileReportPlan";
          benign = true;
        } else if (isComment) {
          classification = "comment prose (the English word), not a section or prompt field";
          benign = true;
        } else {
          classification = "production literal in a section or prompt field";
          benign = false;
        }
        findings.push({ file: rel, line: i + 1, text: trimmed.slice(0, 120), classification, benign });
      });
    }
  }
  return findings;
}

const scanFindings = scanForTargetLiterals();
const targetSpecializationScan = {
  clean: scanFindings.every((f) => f.benign),
  scannedDirs: ["engine/contracts/report", "engine/report/presets", "engine/report/content"],
  note: "templates/** are a separate skill's, outside this engine scan; the target.ts leave/payroll examples are a test fixture, not read by compileReportPlan.",
  findings: scanFindings,
};

// --- 9. Deferred to the LLM host — recorded OPEN, never a pass -------------------
const model = readBehaviorModel(store, analysis.snapshotId);
const behaviorGrade = gradeBehaviorTruth(itemsForFacet(ledger, "M2"), model, ROOT, analysis.testCoverage);
// In-scope misses (status not-found) are the true must-find gap; out-of-scope
// must-find items (unresolved/unsupported) are outside the found/not-found
// denominator and reported apart, so the number is not inflated.
const behaviorInScopeUnfound = behaviorGrade.results
  .filter((r) => r.mustFind && r.status === "not-found")
  .map((r) => ({ truthId: r.truthId, category: r.category, status: r.status, reason: r.detail }));
const behaviorOutOfScope = behaviorGrade.results
  .filter((r) => r.mustFind && r.status !== "found" && r.status !== "not-found")
  .map((r) => ({ truthId: r.truthId, category: r.category, status: r.status, reason: r.detail }));
const notificationCallFacts = resolveKindCoverage(readers, moduleScope, "notification-call").count;
const outboundCallFacts = resolveKindCoverage(readers, moduleScope, "outbound-call").count;
const authoredCount = authoredTasks(executable.plan).length;

// Shared sections rendered from run identity / coverage accounting rather than a KB
// fact slice — this deterministic pass resolves no cited facts for them, so they are
// reported as deferred here rather than as a covered success.
const emptyDeterministicSections = productCoverage.rows
  .concat(developerCoverage.rows)
  .filter((r) => r.scope !== "project" && r.boundFactCount === 0 && r.applicability === "unknown" && (r.sectionId === "identity" || r.sectionId === "coverage"))
  .map((r) => ({ documentQuestion: r.questionId, sectionId: r.sectionId }));

const deferredToLLM = {
  authoredProse: {
    note: "Every validated authored block renders a deterministic fact digest here; the audience-specific prose is the LLM authoring phase's to write and is deferred, not produced.",
    authoredTaskCount: authoredCount,
    validatedAsGroundedOrDisclosure: validatedTaskIds.size,
    gappedAuthoredBlocks,
  },
  emptyDeterministicSections: {
    note: "identity and coverage are rendered from run/snapshot identity and coverage accounting, not a KB fact slice; this fact-grounded pass resolves 0 cited facts for them, so they are marked structured-unknown and deferred here, not reported as covered.",
    sections: emptyDeterministicSections,
  },
  verbatimSourceEquality: {
    note: "Re-reading each cited value against the live source (verbatim-text equality) is the M4 fresh-run content match — deferred, not asserted here.",
  },
  behaviorMustFind: {
    found: behaviorGrade.mustFindFound,
    total: behaviorGrade.mustFindTotal,
    testCoverage: analysis.testCoverage,
    note: "Behaviour must-find over this run's own fresh analysis (test coverage graded from the run). The in-scope misses are open; out-of-scope must-find items are outside the found/not-found denominator.",
    inScopeUnfound: behaviorInScopeUnfound,
    outOfScope: behaviorOutOfScope,
  },
  effectGroundingGaps: {
    notificationCallFacts,
    outboundCallFacts,
    note: "The leave module's outbound authoring sites are now captured as behaviour effect facts (PI-87's outbound-integration-sink capture reverse-reaches the S3 SDK sink through the storage wrapper to a leave export handler), so the module-notifications-data notes block grounds and the 8 notification must-print items print. Leave-scope outbound grounding is S3-only: the SES email send is decoupled via an in-process channel and never reaches a leave handler through the call graph. Notification-call grounding in leave scope remains 0 (a separate deferred item for notification-reachability / the LLM host); the notification section is placed and carries its data-access and outbound-call facts.",
  },
  reportItemsOpen: notPrinted,
};

// --- 10. Assemble the acceptance record and write the artifacts -----------------
const acceptance = {
  target: {
    module: MODULE,
    root: ROOT,
    workspace: WORKSPACE,
    snapshotId: analysis.snapshotId,
    runId: analysis.runId,
    contentIdentity: analysis.identity,
    kbModule: { id: membership.kbModuleId, name: membership.kbModuleName, memberFiles: membership.fileCount },
  },
  presetValidation: { pm: validatePmPreset(), dev: validateDevPreset() },
  questionCoverage: {
    product: { summary: productCoverage.summary, questions: productCoverage.rows },
    developer: { summary: developerCoverage.summary, questions: developerCoverage.rows },
  },
  mustPrintAccounting,
  projectFootprint,
  targetSpecializationScan,
  determinism,
  deferredToLLM,
};

const productRendered = dual.rendered.documents.find((d) => d.documentId === productDoc);
const developerRendered = dual.rendered.documents.find((d) => d.documentId === developerDoc);
if (productRendered !== undefined) writeFileSync(resolve(outDir, "pi21-leave-product.md"), productRendered.markdown);
if (developerRendered !== undefined) writeFileSync(resolve(outDir, "pi22-leave-developer.md"), developerRendered.markdown);
writeFileSync(resolve(outDir, "pi21-23-acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);

// --- 11. Console summary --------------------------------------------------------
const pmOk = acceptance.presetValidation.pm.ok && acceptance.presetValidation.dev.ok;
console.log(`PI-21/22/23 acceptance over ${ROOT}/${MODULE} (content ${analysis.identity.slice(0, 12)}, fresh snapshot ${analysis.snapshotId})`);
console.log(`  kb module: ${membership.kbModuleName} (${membership.kbModuleId}), ${membership.fileCount} member files`);
console.log(`  reports rendered: product=${productRendered !== undefined}, developer=${developerRendered !== undefined}; dual complete=${dual.complete}`);
console.log(`  preset validation ok: pm+dev=${pmOk}`);
console.log(
  `  question coverage product: ${productCoverage.summary.includedWithFacts} with facts, ${productCoverage.summary.structuredUnknownOrNa} structured unknown/na, ${productCoverage.summary.includedZeroFacts} included(0 facts), ${productCoverage.summary.projectNotApplicable} project-na`,
);
console.log(
  `  question coverage developer: ${developerCoverage.summary.includedWithFacts} with facts, ${developerCoverage.summary.structuredUnknownOrNa} structured unknown/na, ${developerCoverage.summary.includedZeroFacts} included(0 facts), ${developerCoverage.summary.projectNotApplicable} project-na`,
);
console.log(
  `  mustPrint PRINTED ${reportGrade.mustPrintPrinted}/${reportGrade.mustPrintTotal} (section PLACED ${mustPrintSectionPresent}/${reportGrade.mustPrintTotal}); criticalIssues ${reportGrade.criticalIssues}; sliceOut ${reportGrade.sliceOutClaims}; crossReport ${reportGrade.crossReportConflicts}; gate passed=${reportGrade.passed}`,
);
console.log(`  gapped authored blocks: ${gappedAuthoredBlocks.map((g) => `${g.documentId}/${g.blockId}(${g.ownKinds.join(",")})`).join("; ") || "none"}`);
console.log(`  project footprint {docs:${footprint.projectDocumentCount}, tasks:${footprint.projectTaskCount}} zero=${projectFootprint.isZeroZero}; dedup ok=${dedup.ok}`);
console.log(`  target-specialization scan clean=${targetSpecializationScan.clean} (${scanFindings.length} classified findings)`);
console.log(`  determinism (content-keyed) equal across two runs=${determinism.equalAcrossTwoRuns}`);
console.log(`    planDigest ${determinism.planDigest.slice(0, 16)} auditDigest ${determinism.auditDigest.slice(0, 16)} execDigest ${determinism.executionDigest.slice(0, 16)} renderDigest ${determinism.renderedManifestDigest.slice(0, 16)}`);
console.log(
  `  deferred: authored prose (${authoredCount} tasks, ${gappedAuthoredBlocks.length} gapped), identity/coverage deterministic sections, verbatim re-read, behaviour must-find ${behaviorGrade.mustFindFound}/${behaviorGrade.mustFindTotal} (${behaviorInScopeUnfound.length} in-scope open, ${behaviorOutOfScope.length} out-of-scope), notification/outbound facts in scope ${notificationCallFacts}/${outboundCallFacts}, report items open ${notPrinted.length}`,
);
console.log(`  -> ${outDir}/pi21-leave-product.md, ${outDir}/pi22-leave-developer.md, ${outDir}/pi21-23-acceptance.json`);

store.close();
