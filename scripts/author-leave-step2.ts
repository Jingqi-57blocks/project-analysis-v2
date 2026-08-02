/**
 * Step-2 authoring of the WCP-V2 leave dual detail reports (PI-21 product + PI-22
 * developer): the model-AGNOSTIC prose-authoring pipeline, driven end-to-end.
 *
 *   tsx scripts/author-leave-step2.ts [workspacePath]
 *
 * It reuses accept-pi-21-23.ts's fresh, source-reproducible analysis and plan
 * compilation verbatim, then exercises the authoring layer in two phases the engine
 * owns, around the one phase it does not:
 *
 *   PHASE A — compile the plan, build one `AuthoringRequest` per authored block whose
 *     own slice grounds ≥1 fact, and write each (prompt + indexed digest + facts) to
 *     `.analysis/authoring/<taskId>.json`. This is the work order for phase B.
 *
 *   PHASE B — the real prose. NOT this script's: an orchestrator runs a model over
 *     each request and drops the answer at `.analysis/authoring/<taskId>.prose.txt`.
 *     The engine calls no model here.
 *
 *   PHASE C — read any `.prose.txt` answers into a prose store via the authoring
 *     host, validate their grounding, render the dual report and write an audit. When
 *     an answer is absent this runs a DRY-RUN placeholder (grounding-clean prose
 *     derived from the facts) so the whole seam is exercised, and marks that block
 *     "placeholder — awaiting phase-B authoring" — never counted as real authored prose.
 *
 * Writes only under .analysis. It calls no model itself.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { runAnalyze } from "../engine/run/analyze.js";
import { openStore } from "../engine/store/open.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { compileExecutablePlan } from "../engine/report/plan.js";
import { produceDualReport } from "../engine/report/dual-report.js";
import { executeAuthoredTasks } from "../engine/report/execute.js";
import { projectLevelFootprint, verifyDedup } from "../engine/report/combination.js";
import { type ReportTarget, moduleTarget, targetKey } from "../engine/contracts/report/target.js";
import type { SectionDefinition } from "../engine/contracts/report/catalog.js";
import { type GenerationParams, authoredTasks } from "../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../engine/contracts/report/snapshot.js";
import type { KindCoverageInput, SectionApplicabilityDecision } from "../engine/report/applicability.js";
import { PM_QUESTIONS, pmQuestionCoverage } from "../engine/report/presets/pm.js";
import { DEV_QUESTIONS, devQuestionCoverage } from "../engine/report/presets/dev.js";
import { PM_AUTHORED_BLOCKS } from "../engine/report/presets/pm.js";
import { DEV_AUTHORED_BLOCKS } from "../engine/report/presets/dev.js";
import {
  coverageInputForKind,
  createSliceReaders,
  resolveKindCoverage,
  resolveModuleMembership,
} from "../engine/report/slice-resolve.js";
import type { CitedFact } from "../engine/report/slice-resolve.js";
import { type DecisionIndex, deterministicContent } from "../engine/report/deterministic-content.js";
import {
  type AuthoredPromptContract,
  buildAuthoringRequests,
  citationLabel,
} from "../engine/report/author-prompt.js";
import { type ProseAuthor, type ProseStore, authoringHost } from "../engine/report/authoring-host.js";
import { authoredContent } from "../engine/report/authored-content.js";
import { validateGrounding } from "../engine/report/grounding.js";

const MODULE = "leave";
const ROOT = "wcp-service-v2";
const outDir = ".analysis";
const authoringDir = resolve(outDir, "authoring");
const WORKSPACE = resolve(process.argv[2] ?? resolve(homedir(), "Documents/WCP-V2"));
const rootPath = resolve(WORKSPACE, ROOT);
const dbPath = resolve(outDir, "pi21-step2.sqlite");

const NO_ROADMAP = /\b(?:should|recommend|suggest|in future|todo|fix|improve|we could)\b/gi;

// --- 1. Fresh, deterministic per-root analysis (identical setup to accept-pi-21-23) ---
mkdirSync(outDir, { recursive: true });
mkdirSync(authoringDir, { recursive: true });
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
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-pi21-step2", language: "en" };
const request: readonly ReportTarget[] = [moduleTarget(MODULE, "product"), moduleTarget(MODULE, "developer")];

function realCoverage(target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] {
  return section.inputFactKinds.map((kind) => ({ kind, coverage: coverageInputForKind(resolveKindCoverage(readers, target.scope, kind)) }));
}

function decisionIndex(applicability: readonly { documentId: string; decision: SectionApplicabilityDecision }[]): DecisionIndex {
  const index = new Map<string, Map<string, SectionApplicabilityDecision>>();
  for (const { documentId, decision } of applicability) {
    const inner = index.get(documentId) ?? new Map<string, SectionApplicabilityDecision>();
    inner.set(decision.sectionId, decision);
    index.set(documentId, inner);
  }
  return index;
}

const executable = compileExecutablePlan({ request, snapshot: snapshotIdentity, params, analysisRunId: analysis.identity, coverage: realCoverage });
const decisions = decisionIndex(executable.applicability);

function contractsByBlockId(): Map<string, AuthoredPromptContract> {
  const map = new Map<string, AuthoredPromptContract>();
  for (const c of [...PM_AUTHORED_BLOCKS, ...DEV_AUTHORED_BLOCKS]) map.set(c.blockId, c);
  return map;
}
const contracts = contractsByBlockId();

const taskById = new Map(authoredTasks(executable.plan).map((t) => [t.taskId, t] as const));
function taskSliceKey(taskId: string): string {
  return taskById.get(taskId)?.factSlice.sliceKey ?? "";
}

// --- PHASE A: build and persist the authoring work order -------------------------
const authoringRequests = buildAuthoringRequests(executable.plan, readers, decisions, contracts);
for (const req of authoringRequests) {
  writeFileSync(
    resolve(authoringDir, `${req.taskId}.json`),
    `${JSON.stringify({ taskId: req.taskId, documentId: req.documentId, sectionId: req.sectionId, blockId: req.blockId, audience: req.audience, sliceKey: taskSliceKey(req.taskId), prompt: req.prompt, digest: req.digest, facts: req.facts }, null, 2)}\n`,
  );
}

// --- PHASE C: read phase-B prose (or dry-run placeholders), author, render, audit ---
// A placeholder is grounding-clean prose derived from the facts: it cites every fact
// by its [n] index and quotes nothing, so it validates without standing in for real
// authored prose. Blocks authored this way are marked, never counted as authored.
const placeholderTaskIds = new Set<string>();
// A bounded placeholder: cite the first few facts by their [n] index (grounding needs
// ≥1), so the seam is exercised without dumping every fact as pseudo-prose.
const PLACEHOLDER_FACT_CAP = 40;
function placeholderProse(facts: readonly CitedFact[]): string {
  const shown = facts.slice(0, PLACEHOLDER_FACT_CAP);
  const head = shown.map((f, i) => `Cited fact ${i + 1} (${f.kind}) is recorded at ${citationLabel(f.citation)} [${i + 1}].`).join(" ");
  const tail = facts.length > shown.length ? ` (${facts.length - shown.length} further cited fact(s) elided from this placeholder.)` : "";
  return `Placeholder prose — awaiting phase-B authoring. ${head}${tail}`;
}

const author: ProseAuthor = (req) => {
  const prosePath = resolve(authoringDir, `${req.taskId}.prose.txt`);
  if (existsSync(prosePath)) return { prose: readFileSync(prosePath, "utf8") };
  placeholderTaskIds.add(req.taskId);
  return { prose: placeholderProse(req.facts) };
};

const proseStore: ProseStore = new Map();
const host = authoringHost({ readers, decisions, contractsByBlockId: contracts, author, proseStore });
const run = executeAuthoredTasks(executable.plan, host);
const validatedTaskIds = new Set(run.artifacts.filter((a) => a.validated).map((a) => a.taskId));

const content = authoredContent(proseStore, deterministicContent({ readers, decisions }));
const groundedByTask = new Map<string, readonly string[]>([...proseStore].map(([taskId, a]) => [taskId, a.groundedFactIds]));
const dual = produceDualReport(executable.plan, executable.slices, run.artifacts, content, { groundedFactIdsByTask: groundedByTask });

const productDoc = targetKey(moduleTarget(MODULE, "product"));
const developerDoc = targetKey(moduleTarget(MODULE, "developer"));
const productRendered = dual.rendered.documents.find((d) => d.documentId === productDoc);
const developerRendered = dual.rendered.documents.find((d) => d.documentId === developerDoc);
if (productRendered !== undefined) writeFileSync(resolve(outDir, "step2-leave-product.md"), productRendered.markdown);
if (developerRendered !== undefined) writeFileSync(resolve(outDir, "step2-leave-developer.md"), developerRendered.markdown);

// --- Audit: per authored block grounding, question join, no-roadmap scan ----------
interface AuthoredBlockAudit {
  readonly taskId: string;
  readonly documentId: string;
  readonly sectionId: string;
  readonly blockId: string;
  readonly sliceKey: string;
  readonly validated: boolean;
  readonly status: string;
  readonly placeholder: boolean;
  readonly groundingOk: boolean | null;
  readonly groundedFactIds: readonly string[];
  readonly foreignCitations: readonly string[];
  readonly valueMismatches: readonly { readonly quoted: string; readonly marker: string }[];
  /** Best-effort: factual sentences that carry no citation — the reviewer's (M6) trail. */
  readonly uncitedFactualSentenceCount: number;
  readonly uncitedFactualSentences: readonly string[];
  readonly noRoadmapHits: readonly string[];
}

const authoredBlocks: AuthoredBlockAudit[] = authoredTasks(executable.plan)
  .map((task): AuthoredBlockAudit => {
    const artifact = proseStore.get(task.taskId);
    const validated = validatedTaskIds.has(task.taskId);
    const sliceKey = task.factSlice.sliceKey;
    if (artifact === undefined) {
      // Not authored: either a structured disclosure (validated, no prose) or a gap.
      return {
        taskId: task.taskId,
        documentId: task.documentId,
        sectionId: task.sectionId,
        blockId: task.blockId,
        sliceKey,
        validated,
        status: validated ? "structured-disclosure (no prose)" : "gap (no facts, no disclosure)",
        placeholder: false,
        groundingOk: null,
        groundedFactIds: [],
        foreignCitations: [],
        valueMismatches: [],
        uncitedFactualSentenceCount: 0,
        uncitedFactualSentences: [],
        noRoadmapHits: [],
      };
    }
    const grounding = validateGrounding(artifact.prose, artifact.facts);
    const placeholder = placeholderTaskIds.has(task.taskId);
    return {
      taskId: task.taskId,
      documentId: task.documentId,
      sectionId: task.sectionId,
      blockId: task.blockId,
      sliceKey,
      validated,
      status: placeholder ? "placeholder — awaiting phase-B authoring" : "authored (grounded)",
      placeholder,
      groundingOk: grounding.ok,
      groundedFactIds: grounding.groundedFactIds,
      foreignCitations: grounding.foreignCitations,
      valueMismatches: grounding.valueMismatches,
      uncitedFactualSentenceCount: grounding.uncitedFactualSentences.length,
      uncitedFactualSentences: grounding.uncitedFactualSentences,
      noRoadmapHits: [...new Set(artifact.prose.match(NO_ROADMAP) ?? [])].sort(),
    };
  })
  .sort((a, b) => (`${a.documentId}/${a.blockId}` < `${b.documentId}/${b.blockId}` ? -1 : 1));

// question → section → grounding join, reusing the preset coverage projectors.
const productDecisions = Object.fromEntries(decisions.get(productDoc) ?? new Map());
const developerDecisions = Object.fromEntries(decisions.get(developerDoc) ?? new Map());
const pmStatus = new Map(pmQuestionCoverage(productDecisions).map((s) => [s.questionId, s] as const));
const devStatus = new Map(devQuestionCoverage(developerDecisions).map((s) => [s.questionId, s] as const));

function questionJoin(
  documentId: string,
  questions: readonly { id: string; sectionId: string; scope: string }[],
  status: ReadonlyMap<string, { applicability: string; reason: string }>,
) {
  const blocksBySection = new Map<string, AuthoredBlockAudit[]>();
  for (const b of authoredBlocks) {
    if (b.documentId !== documentId) continue;
    (blocksBySection.get(b.sectionId) ?? blocksBySection.set(b.sectionId, []).get(b.sectionId)!).push(b);
  }
  return questions.map((q) => {
    if (q.scope === "project") {
      return { questionId: q.id, sectionId: q.sectionId, scope: q.scope, applicability: "not-applicable(module-scope)", authoredBlocks: [] as string[] };
    }
    const s = status.get(q.id);
    const blocks = (blocksBySection.get(q.sectionId) ?? []).map((b) => `${b.blockId}:${b.groundingOk === null ? b.status : b.groundingOk ? "grounded" : "ungrounded"}${b.placeholder ? "(placeholder)" : ""}`);
    return { questionId: q.id, sectionId: q.sectionId, scope: q.scope, applicability: s?.applicability ?? "unknown", authoredBlocks: blocks };
  });
}

const footprint = projectLevelFootprint(executable);
const dedup = verifyDedup(request, executable);

const placeholderCount = authoredBlocks.filter((b) => b.placeholder).length;
const realAuthoredCount = authoredBlocks.filter((b) => b.groundingOk !== null && !b.placeholder).length;
const noRoadmapFindings = authoredBlocks.filter((b) => b.noRoadmapHits.length > 0).map((b) => ({ blockId: b.blockId, documentId: b.documentId, hits: b.noRoadmapHits }));

const audit = {
  target: {
    module: MODULE,
    root: ROOT,
    // Basename only — the machine-absolute path never enters the audit (portable if compared).
    workspace: basename(WORKSPACE),
    snapshotId: analysis.snapshotId,
    contentIdentity: analysis.identity,
    kbModule: { id: membership.kbModuleId, name: membership.kbModuleName, memberFiles: membership.fileCount },
  },
  phaseA: {
    note: "One AuthoringRequest per authored block whose OWN slice resolves ≥1 fact — the phase-B work order.",
    authoringRequestCount: authoringRequests.length,
    requests: authoringRequests.map((r) => ({ taskId: r.taskId, documentId: r.documentId, blockId: r.blockId, sliceKey: taskSliceKey(r.taskId), factCount: r.facts.length })),
  },
  phaseB: {
    note: "Real prose is deferred to the orchestrator (a model). This run supplied NO .prose.txt answers, so every authored block below is a DRY-RUN placeholder.",
    prosesReadFromFile: realAuthoredCount,
  },
  phaseC: {
    dryRun: placeholderCount > 0 && realAuthoredCount === 0,
    placeholderCount,
    realAuthoredCount,
    note: "A placeholder validates the grounding/host/authored-content seam without standing in for authored prose; it is marked, never counted as authored.",
  },
  authoredBlocks,
  questionGroundingJoin: {
    product: questionJoin(productDoc, PM_QUESTIONS, pmStatus),
    developer: questionJoin(developerDoc, DEV_QUESTIONS, devStatus),
  },
  noRoadmapScan: {
    pattern: NO_ROADMAP.source,
    clean: noRoadmapFindings.length === 0,
    findings: noRoadmapFindings,
  },
  projectFootprint: {
    projectDocumentCount: footprint.projectDocumentCount,
    projectTaskCount: footprint.projectTaskCount,
    isZeroZero: footprint.projectDocumentCount === 0 && footprint.projectTaskCount === 0,
    dedup,
  },
  groundingReceipts: run.ledgers.map((l) => {
    const last = l.attempts.at(-1);
    return { taskId: l.taskId, attempts: l.attempts.length, outcome: last?.outcome ?? null, validationOk: last?.validationOk ?? null, artifactRef: last?.artifactRef ?? null, detail: last?.detail ?? null };
  }),
  determinism: {
    keyedOff: "analysis content identity — reproducible from source; prose bytes are informational for authored runs",
    structureDigest: dual.rendered.manifest.structureDigest,
    renderedBytesDigest: dual.rendered.manifest.renderedBytesDigest,
  },
};

writeFileSync(resolve(outDir, "step2-authoring-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);

// --- Console summary --------------------------------------------------------------
console.log(`PI-21/22 step 2 authoring over ${ROOT}/${MODULE} (content ${analysis.identity.slice(0, 12)}, fresh snapshot ${analysis.snapshotId})`);
console.log(`  kb module: ${membership.kbModuleName} (${membership.kbModuleId}), ${membership.fileCount} member files`);
console.log(`  PHASE A: ${authoringRequests.length} AuthoringRequests written to ${authoringDir}/<taskId>.json`);
for (const r of authoringRequests) console.log(`    - ${r.documentId} / ${r.blockId}  sliceKey=${taskSliceKey(r.taskId)}  (${r.facts.length} facts)`);
console.log(`  PHASE C: reports rendered product=${productRendered !== undefined} developer=${developerRendered !== undefined}; dual complete=${dual.complete}`);
console.log(`    authored blocks: ${realAuthoredCount} real (grounded), ${placeholderCount} placeholder — awaiting phase-B; dry-run=${audit.phaseC.dryRun}`);
console.log(`    no-roadmap scan clean=${audit.noRoadmapScan.clean}; project footprint {docs:${footprint.projectDocumentCount},tasks:${footprint.projectTaskCount}} zero=${audit.projectFootprint.isZeroZero}; dedup ok=${dedup.ok}`);
console.log(`    structureDigest ${audit.determinism.structureDigest.slice(0, 16)} (gate); renderedBytesDigest ${audit.determinism.renderedBytesDigest.slice(0, 16)} (informational)`);
console.log(`  -> ${outDir}/step2-leave-product.md, ${outDir}/step2-leave-developer.md, ${outDir}/step2-authoring-audit.json`);

store.close();
