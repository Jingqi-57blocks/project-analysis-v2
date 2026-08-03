/**
 * Generate reports from a frozen knowledge base, through the report skill.
 *
 * Examples:
 *   pnpm report:skill -- --scope project --audience product --lang zh-CN
 *   pnpm report:skill -- --scope module --module leave --audience product
 *   pnpm report:skill -- --scope project --scope module --module leave --audience product
 *
 * `--scope` and `--audience` are open sets read from the output specs; adding a
 * report type is adding a spec file. Analysis is separate (`pnpm analyze`); this
 * command never opens the analysed project's source.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSpecRegistry } from "../engine/contracts/report/specs.js";
import { buildModuleDirectory } from "../engine/kb/module-directory.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { explainRun, generateReports } from "../engine/report/generate.js";
import { explainFailures, parseArgs, planReport } from "../engine/report/orchestrate.js";
import { claudeSkillRunner } from "../engine/report/skill-port.js";
import { resolveModuleMembership } from "../engine/report/slice-resolve.js";
import { openStore } from "../engine/store/open.js";

const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dbPath = resolve(flag("db", ".analysis/kb.sqlite"));
const outputRoot = resolve(flag("out", ".analysis/reports"));
const model = flag("model", "default");

const store = openStore(dbPath);
const kb = openKnowledgeBase(store);
const snapshot = (kb as unknown as { snapshot: { id: number; runId: string } }).snapshot;

const registry = loadSpecRegistry();
const directory = buildModuleDirectory(store, snapshot.id);
const planned = planReport(parseArgs(argv), registry, directory);
if (!planned.ok) {
  console.error(explainFailures(planned.failures));
  process.exit(2);
}

const membership = new Map<string, { files: ReadonlySet<string>; subjectKeys: ReadonlySet<string> }>();
for (const target of planned.plan.targets) {
  if (target.module === null || membership.has(target.module.id)) continue;
  const resolved = resolveModuleMembership(kb, target.module.structuralName);
  membership.set(target.module.id, {
    files: resolved.files,
    subjectKeys: new Set([
      ...resolved.featureIds,
      ...resolved.rawModuleIds,
      ...(resolved.kbModuleId === null ? [] : [resolved.kbModuleId]),
    ]),
  });
}

const resumeRunId = flag("resume", "");
const chapterConcurrency = Number(flag("chapter-concurrency", "4"));
const targetConcurrency = Number(flag("target-concurrency", "0"));

const result = await generateReports({
  ...(resumeRunId.length === 0 ? {} : { resumeRunId }),
  ...(Number.isFinite(chapterConcurrency) && chapterConcurrency > 0 ? { chapterConcurrency } : {}),
  ...(Number.isFinite(targetConcurrency) && targetConcurrency > 0 ? { targetConcurrency } : {}),
  plan: planned.plan,
  store,
  snapshotId: snapshot.id,
  snapshotIdentity: snapshot.runId,
  outputRoot,
  repoRoot,
  instant: new Date(),
  runSkill: claudeSkillRunner(model),
  membership,
  onProgress: (target, event) => {
    const seconds = String(Math.round(event.elapsedMs / 1000)).padStart(4);
    console.log(`  [${seconds}s] ${target}: ${event.detail}`);
  },
});

console.log(explainRun(result));
if (!result.delivered) {
  console.error("\nnot every target produced a deliverable; see the run directory for diagnostics");
  process.exit(1);
}
