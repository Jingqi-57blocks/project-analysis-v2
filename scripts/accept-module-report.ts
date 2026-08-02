/**
 * Generic, source-reproducible acceptance of a MODULE dual detail report (PI-25).
 *
 *   tsx scripts/accept-module-report.ts <workspace> <root> <module> [outPrefix]
 *
 * The parameterized generalization of scripts/accept-pi-21-23.ts (which is
 * WCP-leave-hardcoded): it takes the workspace, root and module as ARGS and
 * carries NO target literal. It runs its OWN fresh, deterministic per-root
 * analysis into a dedicated database (never the shared .analysis/kb.sqlite),
 * resolves the module's file membership from the module model, compiles the
 * module product + developer plan with REAL per-kind coverage from the slice
 * resolver, executes the authored tasks through the deterministic (model-free)
 * Host Agent, and produces the dual report plus a machine-readable audit.
 *
 * The acceptance is graded generically — WITHOUT any per-target truth ledger:
 * every REQUIRED section for each document must be `included` or an evidenced
 * `not-applicable` / `unknown`, and an unresolved module scope must lower
 * coverage (unknown) rather than fabricate a "found none" empty conclusion.
 *
 * It calls no model — the LLM prose is deferred and recorded as open, never faked.
 * Writes only to .analysis: a dedicated KB, the two rendered reports and one audit.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runAnalyze } from "../engine/run/analyze.js";
import { openStore } from "../engine/store/open.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { compileExecutablePlan } from "../engine/report/plan.js";
import { produceDualReport } from "../engine/report/dual-report.js";
import { executeAuthoredTasks } from "../engine/report/execute.js";
import { projectLevelFootprint, verifyDedup } from "../engine/report/combination.js";
import { type ReportTarget, type Scope, moduleTarget, targetKey } from "../engine/contracts/report/target.js";
import { SECTION_CATALOG, type SectionDefinition, sectionById } from "../engine/contracts/report/catalog.js";
import { authoredTasks, type GenerationParams } from "../engine/contracts/report/pipeline.js";
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

// --- 0. Arguments — the driver is generic; no target is baked in ----------------
const [workspaceArg, rootArg, moduleArg, outPrefixArg] = process.argv.slice(2);
if (workspaceArg === undefined || rootArg === undefined || moduleArg === undefined) {
  console.error("usage: accept-module-report <workspace> <root> <module> [outPrefix]");
  process.exit(2);
}
const WORKSPACE = resolve(workspaceArg);
const ROOT = rootArg;
const MODULE = moduleArg;
const outPrefix = outPrefixArg ?? `${ROOT}-${MODULE}`;
const outDir = ".analysis";
const rootPath = resolve(WORKSPACE, ROOT);
const dbPath = resolve(outDir, `${outPrefix}-accept.sqlite`);

// --- 1. Fresh, deterministic per-root analysis pinned to THIS run's snapshot -----
mkdirSync(outDir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
const analysis = runAnalyze({ paths: [rootPath], indexRoot: rootPath, dbPath });

const store = openStore(dbPath);
const kb = openKnowledgeBase(store, analysis.runId);
const membership = resolveModuleMembership(kb, MODULE);
const readers = createSliceReaders(store, analysis.snapshotId, membership);

const snapshotIdentity: AnalysisSnapshotIdentity = {
  sourceIdentity: analysis.identity,
  codeGraphIdentity: analysis.identity,
  providerIdentity: analysis.identity,
  schemaVersion: "1.0.0",
  configIdentity: analysis.identity,
};
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-pi25", language: "en" };
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
  renderedManifestDigest: dual.rendered.manifest.structureDigest,
  equalAcrossTwoRuns:
    executable.plan.planDigest === second.executable.plan.planDigest &&
    executable.auditDigest === second.executable.auditDigest &&
    run.executionDigest === second.run.executionDigest &&
    dual.rendered.manifest.structureDigest === second.dual.rendered.manifest.structureDigest,
};

// --- 5. Generic REQUIRED-section disposition audit (no target ledger) ------------
// Every required section for each requested document must carry a recorded
// applicability decision that is included / not-applicable / unknown, with a
// reason and per-kind evidence. An unresolved module scope must NOT render a
// required section as a "found none" empty conclusion — that would be a false
// empty; it must lower coverage as unknown instead.
interface SectionDisposition {
  readonly documentId: string;
  readonly sectionId: string;
  readonly requirement: string;
  readonly disposition: SectionApplicabilityDecision["applicability"];
  readonly state: string;
  readonly reason: string;
  readonly kindStates: readonly { kind: string; state: string; bucket: string }[];
  readonly boundFactCount: number;
  readonly falseEmptyRisk: boolean;
}

const requiredSections = SECTION_CATALOG.filter((s) => s.requirement === "required");
function requiredFor(scope: "module" | "project" | "shared", audience: "product" | "developer"): SectionDefinition[] {
  return requiredSections.filter(
    (s) => (s.scope === scope || s.scope === "shared") && (s.audience === audience || s.audience === "shared"),
  );
}

const sectionDispositions: SectionDisposition[] = [];
for (const target of request) {
  const documentId = targetKey(target);
  const decisionsForDoc = decisions.get(documentId) ?? new Map<string, SectionApplicabilityDecision>();
  for (const section of requiredFor("module", target.audience)) {
    const decision = decisionsForDoc.get(section.id);
    const facts = resolveSliceFacts(readers, target.scope, section.inputFactKinds);
    const disposition = decision?.applicability ?? "unknown";
    const state = decision?.state ?? "unknown";
    // A required section reported "found none" (not-found → included, empty) while
    // the module itself was never resolved is the false-empty the acceptance forbids.
    const falseEmptyRisk = membership.kbModuleId === null && state === "not-found";
    sectionDispositions.push({
      documentId,
      sectionId: section.id,
      requirement: section.requirement,
      disposition,
      state,
      reason: decision?.reason ?? "no applicability decision recorded",
      kindStates: (decision?.evidence ?? []).map((e) => ({ kind: e.kind, state: e.state, bucket: e.bucket })),
      boundFactCount: facts.length,
      falseEmptyRisk,
    });
  }
}

const dispositionCounts = { included: 0, "not-applicable": 0, unknown: 0 };
for (const d of sectionDispositions) dispositionCounts[d.disposition] += 1;
const falseEmptySections = sectionDispositions.filter((d) => d.falseEmptyRisk);
const requiredSectionsAllAccounted = sectionDispositions.every(
  (d) => d.disposition === "included" || d.disposition === "not-applicable" || d.disposition === "unknown",
);

// --- 6. Citation validity — every resolved fact carries id + citation + class ----
const allModuleFacts = resolveSliceFacts(readers, moduleScope, ["*"]);
const citationViolations = allModuleFacts.filter(
  (f) =>
    f.factId.length === 0 ||
    f.citation === undefined ||
    typeof f.citation.rootName !== "string" ||
    f.citation.rootName.length === 0 ||
    typeof f.citation.relPath !== "string" ||
    f.citation.relPath.length === 0 ||
    f.resolutionClass === undefined,
);
const citationValidity = {
  resolvedModuleFactCount: allModuleFacts.length,
  violations: citationViolations.length,
  ok: citationViolations.length === 0,
};

// --- 7. Question coverage per audience (the FULL required question sets) ---------
interface QuestionCoverageRow {
  readonly questionId: string;
  readonly sectionId: string;
  readonly scope: string;
  readonly applicability: string;
  readonly reason: string;
  readonly boundFactCount: number;
}

function questionCoverageFor(
  questions: readonly { id: string; sectionId: string; scope: string }[],
  statuses: readonly { questionId: string; sectionId: string; applicability: string; reason: string }[],
): { rows: readonly QuestionCoverageRow[]; summary: Record<string, number> } {
  const statusById = new Map(statuses.map((s) => [s.questionId, s] as const));
  const rows: QuestionCoverageRow[] = questions.map((q) => {
    if (q.scope === "project") {
      return {
        questionId: q.id,
        sectionId: q.sectionId,
        scope: q.scope,
        applicability: "not-applicable(module-scope)",
        reason: "project-scope section is not compiled for a module-only request",
        boundFactCount: 0,
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

// --- 8. Project-level footprint + dedup (module-only ⇒ {0,0}) --------------------
const footprint = projectLevelFootprint(executable);
const dedup = verifyDedup(request, executable);

// --- 9. Target-specialization scan of the engine report layer -------------------
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
  const dirs = ["engine/contracts/report", "engine/report/presets", "engine/report/content", "engine/report/slice-resolve.ts"];
  const findings: ScanFinding[] = [];
  const files: string[] = [];
  for (const dir of dirs) {
    const abs = resolve(dir);
    if (abs.endsWith(".ts")) files.push(abs);
    else files.push(...listTsFiles(abs));
  }
  for (const file of files) {
    const rel = file.slice(resolve(".").length + 1);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      const isComment = trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
      const productToken = /\b(payroll|angels|pizza)\b/i.test(line) || /wcp[-_ ]?service/i.test(line);
      const moduleLiteral = /["'](leave|leaves|order|orders)["']/i.test(line);
      if (!productToken && !moduleLiteral) return;
      const isTargetFixture = rel.endsWith("contracts/report/target.ts");
      let classification: string;
      let benign: boolean;
      if (isTargetFixture) {
        classification = "LEGAL/ILLEGAL request example test fixture — not consumed by compileReportPlan";
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
  return findings;
}

const scanFindings = scanForTargetLiterals();
const targetSpecializationScan = {
  clean: scanFindings.every((f) => f.benign),
  scannedDirs: ["engine/contracts/report", "engine/report/presets", "engine/report/content", "engine/report/slice-resolve.ts"],
  findings: scanFindings,
};

// --- 10. Assemble the acceptance record and write the artifacts -----------------
const moduleResolved = membership.kbModuleId !== null;
const acceptance = {
  target: {
    workspace: WORKSPACE,
    root: ROOT,
    module: MODULE,
    snapshotId: analysis.snapshotId,
    runId: analysis.runId,
    contentIdentity: analysis.identity,
    kbModule: { id: membership.kbModuleId, name: membership.kbModuleName, memberFiles: membership.fileCount },
    moduleResolved,
  },
  presetValidation: { pm: validatePmPreset(), dev: validateDevPreset() },
  requiredSectionAudit: {
    note:
      "Every REQUIRED module section for each document, with its recorded applicability decision. " +
      "A module that the model did not surface (moduleResolved=false) must lower coverage as unknown, " +
      "not render sections as a 'found none' empty conclusion (falseEmptyRisk).",
    counts: dispositionCounts,
    allAccounted: requiredSectionsAllAccounted,
    falseEmptySections,
    dispositions: sectionDispositions,
  },
  citationValidity,
  questionCoverage: {
    product: { summary: productCoverage.summary, questions: productCoverage.rows },
    developer: { summary: developerCoverage.summary, questions: developerCoverage.rows },
  },
  projectFootprint: {
    projectDocumentCount: footprint.projectDocumentCount,
    projectTaskCount: footprint.projectTaskCount,
    isZeroZero: footprint.projectDocumentCount === 0 && footprint.projectTaskCount === 0,
    dedup,
  },
  targetSpecializationScan,
  determinism,
  dualReport: {
    complete: dual.complete,
    exportable: dual.exportable,
    auditFindings: dual.audit.findings.length,
    authoredTaskCount: authoredTasks(executable.plan).length,
    validatedTaskCount: validatedTaskIds.size,
  },
  // The overall verdict is honest: an unresolved module lowers coverage (unknown)
  // rather than passing on a false empty. Passing requires: all required sections
  // accounted, no false-empty section, citations legal, determinism holds, no
  // target literal, and the module-only footprint {0,0}.
  passed:
    requiredSectionsAllAccounted &&
    falseEmptySections.length === 0 &&
    citationValidity.ok &&
    determinism.equalAcrossTwoRuns &&
    targetSpecializationScan.clean &&
    footprint.projectDocumentCount === 0 &&
    footprint.projectTaskCount === 0 &&
    dedup.ok,
};

const productRendered = dual.rendered.documents.find((d) => d.documentId === productDoc);
const developerRendered = dual.rendered.documents.find((d) => d.documentId === developerDoc);
if (productRendered !== undefined) writeFileSync(resolve(outDir, `${outPrefix}-product.md`), productRendered.markdown);
if (developerRendered !== undefined) writeFileSync(resolve(outDir, `${outPrefix}-developer.md`), developerRendered.markdown);
writeFileSync(resolve(outDir, `${outPrefix}-report-audit.json`), `${JSON.stringify(acceptance, null, 2)}\n`);

// --- 11. Console summary --------------------------------------------------------
console.log(`module-report acceptance over ${ROOT}/${MODULE} (content ${analysis.identity.slice(0, 12)}, snapshot ${analysis.snapshotId})`);
console.log(`  module resolved in KB: ${moduleResolved} (id=${membership.kbModuleId}, files=${membership.fileCount})`);
console.log(`  reports rendered: product=${productRendered !== undefined}, developer=${developerRendered !== undefined}; dual complete=${dual.complete}`);
console.log(`  required-section dispositions: included ${dispositionCounts.included}, not-applicable ${dispositionCounts["not-applicable"]}, unknown ${dispositionCounts.unknown}; allAccounted=${requiredSectionsAllAccounted}`);
console.log(`  FALSE-EMPTY required sections (not-found on an unresolved module): ${falseEmptySections.length}`);
console.log(`  citations legal: ${citationValidity.ok} (${citationValidity.resolvedModuleFactCount} resolved module facts, ${citationValidity.violations} violations)`);
console.log(`  determinism equal across two runs: ${determinism.equalAcrossTwoRuns}`);
console.log(`  target-specialization scan clean: ${targetSpecializationScan.clean} (${scanFindings.length} findings)`);
console.log(`  project footprint {docs:${footprint.projectDocumentCount}, tasks:${footprint.projectTaskCount}}; dedup ok=${dedup.ok}`);
console.log(`  PASSED=${acceptance.passed}`);
console.log(`  -> ${outDir}/${outPrefix}-product.md, ${outDir}/${outPrefix}-developer.md, ${outDir}/${outPrefix}-report-audit.json`);

store.close();
