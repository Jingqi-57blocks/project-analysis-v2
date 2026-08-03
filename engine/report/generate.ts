/**
 * Running a report plan.
 *
 * Parse → match spec → slice → skill produces claims → skill produces the view →
 * audit → record. One fact pack is cut per scope and shared by every target that
 * reads it, and the run's artefacts land in a directory that is never reused.
 *
 * Failure is always a stop, never a quieter success: a blocked gate, an
 * unresolved module and a failed audit each end with an explanation and no
 * deliverable. A report that silently omits what it could not support reads
 * exactly like one that had nothing to say.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { indexClaims, type Claim } from "../contracts/claim/index.js";
import { buildFactPack, type FactPack } from "../kb/fact-pack.js";
import { writeFactPack } from "../kb/fact-pack-io.js";
import { evaluateGate, explainVerdict } from "../kb/generation-gate.js";
import { auditReport, readInventory, type AuditResult } from "./kb-audit.js";
import type { PlannedTarget, ReportPlan } from "./orchestrate.js";
import {
  allocateRunDirectory,
  buildManifest,
  writeManifest,
  type RunManifest,
  type TargetRecord,
} from "./run-identity.js";
import type { SkillRunner } from "./skill-port.js";
import type { Store } from "../store/types.js";

/** Kinds without which a spec's mandatory chapters cannot be written. */
const MANDATORY_KINDS: readonly string[] = ["run-context", "coverage-note"];

export interface GenerateInput {
  readonly plan: ReportPlan;
  readonly store: Store;
  readonly snapshotId: number;
  readonly snapshotIdentity: string;
  readonly outputRoot: string;
  readonly repoRoot: string;
  readonly instant: Date;
  readonly runSkill: SkillRunner;
  /** Membership for each planned module, resolved by the caller. */
  readonly membership: ReadonlyMap<string, { files: ReadonlySet<string>; subjectKeys: ReadonlySet<string> }>;
}

export interface TargetOutcome {
  readonly target: PlannedTarget;
  readonly record: TargetRecord;
  readonly audit: AuditResult | null;
  /** Why this target produced nothing, when it did not. */
  readonly blocked: string | null;
}

export interface GenerateResult {
  readonly runId: string;
  readonly runPath: string;
  readonly manifest: RunManifest;
  readonly outcomes: readonly TargetOutcome[];
  /** True only if every target produced a report that passed its audit. */
  readonly delivered: boolean;
}

function packFor(input: GenerateInput, target: PlannedTarget): FactPack {
  const membership = target.module === null ? undefined : input.membership.get(target.module.id);
  return buildFactPack(input.store, input.snapshotId, input.snapshotIdentity, {
    scope: target.scope,
    requires: target.spec.requires,
    kbModuleId: target.module?.id ?? null,
    ...(target.module === null ? {} : { moduleId: target.module.structuralName }),
    ...(membership === undefined ? {} : { moduleFiles: membership.files, subjectKeys: membership.subjectKeys }),
  });
}

function readClaims(path: string): readonly Claim[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { claims?: readonly Claim[] };
  return parsed.claims ?? [];
}

/**
 * Runs every target in the plan.
 *
 * Packs are cut once per `packKey`; two audiences over one module therefore see
 * the same facts by construction rather than by coincidence.
 */
export async function generateReports(input: GenerateInput): Promise<GenerateResult> {
  const { runId, path: runPath } = allocateRunDirectory(input.outputRoot, input.plan.runLabel, input.instant);
  const inventory = readInventory(input.store, input.snapshotId);
  const packDirs = new Map<string, string>();
  const outcomes: TargetOutcome[] = [];
  let modelTier = "unknown";

  for (const target of input.plan.targets) {
    const base = { scope: target.scope, audience: target.audience, module: target.module?.structuralName ?? null };
    const record = (over: Partial<TargetRecord>): TargetRecord => ({
      ...base,
      specId: target.spec.id,
      specVersion: target.spec.version,
      directory: target.directory,
      auditPassed: null,
      ...over,
    });

    const pack = packFor(input, target);
    const gate = evaluateGate({ pack, mandatoryKinds: MANDATORY_KINDS });
    if (!gate.ok) {
      outcomes.push({ target, record: record({}), audit: null, blocked: explainVerdict(gate) });
      continue;
    }

    let packDir = packDirs.get(target.packKey);
    if (packDir === undefined) {
      packDir = `${runPath}/packs/${target.packKey.replace(/[^\w.-]+/g, "-")}`;
      writeFactPack(pack, packDir);
      packDirs.set(target.packKey, packDir);
    }

    const targetDir = `${runPath}/${target.directory}`;
    mkdirSync(targetDir, { recursive: true });
    const claimsPath = `${targetDir}/claims.json`;
    const viewPath = `${targetDir}/report.md`;

    try {
      const outcome = await input.runSkill({
        packDir,
        specId: target.spec.id,
        language: input.plan.language,
        claimsPath,
        viewPath,
        repoRoot: input.repoRoot,
      });
      modelTier = outcome.modelTier;
    } catch (error) {
      outcomes.push({
        target,
        record: record({}),
        audit: null,
        blocked: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!existsSync(viewPath)) {
      outcomes.push({ target, record: record({}), audit: null, blocked: "the skill wrote no view" });
      continue;
    }

    const claims = readClaims(claimsPath);
    const { invalid } = indexClaims([...claims]);
    const audit = auditReport({ report: readFileSync(viewPath, "utf8"), inventory, pack, claims });
    const passed = audit.passed && invalid.length === 0;
    writeFileSync(
      `${targetDir}/audit.json`,
      JSON.stringify({ passed, findings: audit.findings, invalidClaims: invalid, kindUsage: audit.kindUsage }, null, 2) +
        "\n",
    );
    outcomes.push({ target, record: record({ auditPassed: passed }), audit, blocked: null });
  }

  const manifest = buildManifest({
    runId,
    instant: input.instant,
    snapshotIdentity: input.snapshotIdentity,
    language: input.plan.language,
    modelTier,
    targets: outcomes.map((outcome) => outcome.record),
  });
  writeManifest(runPath, manifest);

  return {
    runId,
    runPath,
    manifest,
    outcomes,
    delivered: outcomes.length > 0 && outcomes.every((outcome) => outcome.record.auditPassed === true),
  };
}

/** A short account of what a run produced, and of what it refused to produce. */
export function explainRun(result: GenerateResult): string {
  const lines = [`run ${result.runId} → ${result.runPath}`];
  for (const outcome of result.outcomes) {
    if (outcome.blocked !== null) {
      lines.push(`  ${outcome.target.directory}: NOT PRODUCED`);
      for (const line of outcome.blocked.split("\n")) lines.push(`    ${line}`);
      continue;
    }
    const verdict = outcome.record.auditPassed === true ? "audit passed" : "AUDIT FAILED — not a deliverable";
    lines.push(`  ${outcome.target.directory}: ${verdict}`);
    for (const finding of outcome.audit?.findings.slice(0, 5) ?? []) {
      lines.push(`    - [${finding.code}] ${finding.evidence}`);
    }
  }
  return lines.join("\n");
}
