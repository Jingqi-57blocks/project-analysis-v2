/**
 * Generate Chinese non-technical project/module reports from one published KB.
 *
 * Examples:
 *   pnpm report -- --project --module leave --module worklog
 *   pnpm report -- --module leave --db .analysis/kb.sqlite --out /tmp/leave-report
 *
 * Analysis is deliberately separate (`pnpm analyze`). This command never opens
 * source: classification, authoring and HTML export all consume the same frozen
 * snapshot, and their artifacts are reused while identities remain unchanged.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SectionDefinition } from "../engine/contracts/report/catalog.js";
import type { GenerationParams } from "../engine/contracts/report/pipeline.js";
import { moduleTarget, projectTarget, type ReportTarget } from "../engine/contracts/report/target.js";
import type { AnalysisSnapshotIdentity } from "../engine/contracts/report/snapshot.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { authoredContent } from "../engine/report/authored-content.js";
import { authoringHost, type ProseStore } from "../engine/report/authoring-host.js";
import { prepareBatchAuthor } from "../engine/report/batch-author.js";
import { deterministicContent, type DecisionIndex } from "../engine/report/deterministic-content.js";
import { produceDualReport } from "../engine/report/dual-report.js";
import { executeAuthoredTasks } from "../engine/report/execute.js";
import {
  classifyReportModules,
  findReportModule,
  membershipForReportModule,
  productReportModules,
  reportableReportModules,
} from "../engine/report/module-catalog.js";
import { compileExecutablePlan } from "../engine/report/plan.js";
import { PM_AUTHORED_BLOCKS } from "../engine/report/presets/pm.js";
import { exportProductReportSite } from "../engine/report/site-export.js";
import {
  coverageInputForKind,
  createSliceReaders,
  resolveKindCoverage,
} from "../engine/report/slice-resolve.js";
import type { KindCoverageInput, SectionApplicabilityDecision } from "../engine/report/applicability.js";
import { assertOutsideRoots } from "../engine/run/analyze.js";
import { openStore } from "../engine/store/open.js";
import type { Store } from "../engine/store/types.js";
import type { JsonAgentIdentity } from "../engine/host/json-agent.js";

const DEFAULT_DB = ".analysis/kb.sqlite";

interface Args {
  readonly dbPath: string;
  readonly runId?: string;
  readonly workspacePath?: string;
  readonly outDir?: string;
  readonly workDir?: string;
  readonly project: boolean;
  readonly modules: readonly string[];
  readonly language: string;
  readonly model: string;
  readonly reasoning: JsonAgentIdentity["reasoningEffort"];
  readonly classifierReasoning: JsonAgentIdentity["reasoningEffort"];
  readonly concurrency: number;
}

function values(argv: readonly string[], flag: string): readonly string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    result.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
  }
  return result;
}

function value(argv: readonly string[], flag: string): string | undefined {
  return values(argv, flag).at(-1);
}

function parseArgs(argv: readonly string[]): Args {
  const modules = values(argv, "--module");
  const project = argv.includes("--project");
  if (!project && modules.length === 0) {
    throw new Error("Choose at least one report: --project and/or --module <name>");
  }
  const reasoning = value(argv, "--agent-reasoning") ?? "medium";
  if (!["low", "medium", "high", "xhigh"].includes(reasoning)) {
    throw new Error(`--agent-reasoning must be low, medium, high or xhigh; got ${reasoning}`);
  }
  const classifierReasoning = value(argv, "--classifier-reasoning") ?? "low";
  if (!["low", "medium", "high", "xhigh"].includes(classifierReasoning)) {
    throw new Error(`--classifier-reasoning must be low, medium, high or xhigh; got ${classifierReasoning}`);
  }
  const concurrency = Number(value(argv, "--concurrency") ?? "12");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be an integer from 1 to 16");
  }
  const optional = (flag: string): string | undefined => value(argv, flag);
  const runId = optional("--run");
  const workspacePath = optional("--workspace");
  const outDir = optional("--out");
  const workDir = optional("--work");
  return {
    dbPath: resolve(optional("--db") ?? DEFAULT_DB),
    ...(runId === undefined ? {} : { runId }),
    ...(workspacePath === undefined ? {} : { workspacePath: resolve(workspacePath) }),
    ...(outDir === undefined ? {} : { outDir: resolve(outDir) }),
    ...(workDir === undefined ? {} : { workDir: resolve(workDir) }),
    project,
    modules,
    language: optional("--language") ?? "zh-CN",
    model: optional("--agent-model") ?? "default",
    reasoning: reasoning as JsonAgentIdentity["reasoningEffort"],
    classifierReasoning: classifierReasoning as JsonAgentIdentity["reasoningEffort"],
    concurrency,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
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

function contracts() {
  return new Map(PM_AUTHORED_BLOCKS.map((contract) => [contract.blockId, contract] as const));
}

function analysisDuration(store: Store, snapshotId: number): number {
  return store.get<{ total: number | null }>(
    "SELECT SUM(duration_ms) AS total FROM phase_metrics WHERE snapshot_id = ?",
    [snapshotId],
  )?.total ?? 0;
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const store = openStore(args.dbPath);
  try {
    const kb = openKnowledgeBase(store, args.runId, args.workspacePath);
    const workspaceKey = digest(kb.snapshot.workspacePath);
    const runKey = `${kb.snapshot.identity.slice(0, 20)}-${args.language.toLowerCase()}`;
    const workDir = args.workDir ?? resolve(".analysis/report-cache", workspaceKey);
    const outDir = args.outDir ?? resolve(".analysis/reports", runKey);
    const sourceRoots = store.all<{ name: string; path: string }>(
      "SELECT name, path FROM source_roots WHERE snapshot_id = ? ORDER BY name",
      [kb.snapshot.id],
    );
    assertOutsideRoots(outDir, sourceRoots);
    assertOutsideRoots(workDir, sourceRoots);
    mkdirSync(workDir, { recursive: true });
    console.log(`Reading published snapshot ${kb.snapshot.identity.slice(0, 20)}…`);

    const agent: JsonAgentIdentity = {
      executor: "codex-cli",
      model: args.model,
      reasoningEffort: args.reasoning,
    };
    const classifierAgent: JsonAgentIdentity = { ...agent, reasoningEffort: args.classifierReasoning };
    const classificationStarted = performance.now();
    console.log("Classifying the bounded module candidate list (or reusing its cache)…");
    const classified = await classifyReportModules({
      store,
      kb,
      runDir: resolve(workDir, "module-catalog"),
      language: args.language,
      agent: classifierAgent,
    });
    const classificationMs = Math.round((performance.now() - classificationStarted) * 100) / 100;
    const productModules = productReportModules(classified.artifact, classified.input);
    const reportableModules = reportableReportModules(classified.artifact, classified.input);
    if (productModules.length === 0) {
      const unresolved = classified.artifact.candidates.filter((candidate) => candidate.status === "unresolved").length;
      throw new Error(`module classification produced no product modules (${unresolved} unresolved candidate(s)); refusing to widen scope`);
    }

    const selected = args.modules.map((requested) => {
      const module = findReportModule(reportableModules, requested);
      if (module !== null) return module;
      throw new Error(`module "${requested}" did not resolve. Available reportable modules: ${reportableModules.map((entry) => `${entry.displayName} [${entry.rawNames.join(", ")}]`).join("; ")}`);
    });
    const distinctSelected = [...new Map(selected.map((module) => [module.id, module] as const)).values()];
    // An explicitly requested aggregate gets a detail page and appears in this
    // run's overview, without globally promoting every aggregate facade to a
    // product capability.
    const modules = [...new Map(
      [...productModules, ...distinctSelected].map((module) => [module.id, module] as const),
    ).values()].sort((a, b) => a.group.localeCompare(b.group) || a.displayName.localeCompare(b.displayName));
    const memberships = distinctSelected.map((module) => membershipForReportModule(kb, module));
    for (const membership of memberships) {
      if (membership.kbModuleId === null || membership.fileCount === 0) {
        throw new Error(`classified module ${membership.moduleId} has no resolved source membership; refusing an unbounded report`);
      }
    }
    const readers = createSliceReaders(store, kb.snapshot.id, memberships);
    const request: ReportTarget[] = [
      ...(args.project ? [projectTarget("product")] : []),
      ...distinctSelected.map((module) => moduleTarget(module.id, "product")),
    ];

    const snapshot: AnalysisSnapshotIdentity = {
      sourceIdentity: kb.snapshot.identity,
      codeGraphIdentity: kb.snapshot.identity,
      providerIdentity: kb.snapshot.identity,
      schemaVersion: String(store.schemaVersion),
      configIdentity: kb.snapshot.identity,
    };
    const params: GenerationParams = {
      executorKind: agent.executor,
      modelId: agent.model,
      language: args.language,
      params: { reasoningEffort: agent.reasoningEffort },
    };
    const coverage = (target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] => section.inputFactKinds.map((kind) => ({
      kind,
      coverage: coverageInputForKind(resolveKindCoverage(readers, target.scope, kind)),
    }));
    const executable = compileExecutablePlan({
      request,
      snapshot,
      params,
      analysisRunId: kb.snapshot.identity,
      coverage,
    });
    const decisions = decisionIndex(executable.applicability);

    const authoringStarted = performance.now();
    console.log(`Authoring ${request.length} report document(s) from bounded fact slices…`);
    const prepared = await prepareBatchAuthor({
      plan: executable.plan,
      readers,
      decisions,
      contractsByBlockId: contracts(),
      language: args.language,
      agent,
      cacheDir: resolve(workDir, "authored"),
      concurrency: args.concurrency,
    });
    const proseStore: ProseStore = new Map();
    const host = authoringHost({ readers, decisions, contractsByBlockId: contracts(), author: prepared.author, proseStore });
    const execution = executeAuthoredTasks(executable.plan, host);
    const fallback = deterministicContent({ readers, decisions });
    const grounded = new Map([...proseStore.entries()].map(([taskId, artifact]) => [taskId, artifact.groundedFactIds] as const));
    const dual = produceDualReport(
      executable.plan,
      executable.slices,
      execution.artifacts,
      authoredContent(proseStore, fallback),
      { groundedFactIdsByTask: grounded },
    );
    const authoringMs = Math.round((performance.now() - authoringStarted) * 100) / 100;
    if (!dual.complete) {
      throw new Error(`report pipeline incomplete: ${dual.audit.findings.map((finding) => finding.detail).join("; ") || execution.assembly.missingRequired.join(", ")}`);
    }

    console.log("Exporting the audited static HTML site…");
    const site = exportProductReportSite({
      outDir,
      kb,
      readers,
      plan: executable.plan,
      proseStore,
      structuredByTask: prepared.structuredByTask,
      classification: classified.artifact,
      boundedCandidates: classified.boundedCandidates,
      modules,
      selectedModules: distinctSelected,
      projectIncluded: args.project,
      language: args.language,
      metrics: {
        analysisMs: analysisDuration(store, kb.snapshot.id),
        classificationMs,
        authoringMs,
        agentCalls: prepared.agentCalls + classified.classifierCalls,
        cacheHits: prepared.cacheHits + (classified.reused ? 1 : 0),
        agentInputBytes: prepared.agentInputBytes + classified.classifierInputBytes,
        agentOutputBytes: prepared.agentOutputBytes + classified.classifierOutputBytes,
        authoredTaskCount: prepared.taskMetrics.length,
        agentValidationRetries: prepared.taskMetrics.reduce(
          (total, task) => total + task.attempts.filter((attempt) => attempt.outcome === "validation-failed").length,
          0,
        ),
        slowestAuthoringTaskMs: Math.max(0, ...prepared.taskMetrics.map((task) => task.totalMs)),
      },
    });

    const audit = {
      schemaVersion: "product-report-run-audit.v1",
      snapshot: kb.snapshot,
      request,
      classification: {
        reused: classified.reused,
        diagnostics: classified.diagnostics,
        productModules: modules,
        unresolved: classified.artifact.candidates.filter((candidate) => candidate.status === "unresolved").map((candidate) => candidate.candidateId),
      },
      plan: { digest: executable.plan.planDigest, auditDigest: executable.auditDigest },
      execution: {
        digest: execution.executionDigest,
        counters: execution.counters,
        complete: execution.assembly.complete,
        authoringTasks: prepared.taskMetrics,
      },
      report: { complete: dual.complete, audit: dual.audit, manifest: dual.rendered.manifest },
      site: site.manifest,
    };
    writeFileSync(resolve(workDir, `${runKey}-audit.json`), `${JSON.stringify(audit, null, 2)}\n`, "utf8");

    console.log(`Generated ${args.language} non-technical report site for ${kb.snapshot.workspacePath}`);
    console.log(`  snapshot: ${kb.snapshot.identity}`);
    console.log(`  product modules in overview: ${modules.length}`);
    console.log(`  module detail pages: ${distinctSelected.map((module) => module.displayName).join(", ") || "none"}`);
    console.log(`  AI calls: ${prepared.agentCalls + classified.classifierCalls} (${prepared.cacheHits + (classified.reused ? 1 : 0)} cache hit(s))`);
    console.log(`  report: ${resolve(outDir, "index.html")}`);
    console.log(`  manifest: ${site.manifestPath}`);
    return 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
