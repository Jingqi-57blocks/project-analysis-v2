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

import {
  indexClaims,
  makeClaim,
  qualifierConflicts,
  type Claim,
  type QualifierConflict,
} from "../contracts/claim/index.js";
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
import type { SkillProgress, SkillRunner } from "./skill-port.js";
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
  /** Called as each target progresses, so a long run is never a silent wait. */
  readonly onProgress?: (target: string, event: SkillProgress) => void;
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

export interface CrossTargetConflict extends QualifierConflict {
  readonly between: readonly [string, string];
}

export interface GenerateResult {
  readonly runId: string;
  readonly runPath: string;
  readonly manifest: RunManifest;
  readonly outcomes: readonly TargetOutcome[];
  /**
   * Where two targets in this run say different things about one claim.
   *
   * Because identity is the predicate and the subject, a disagreement lands on
   * one claimId and is visible here; it cannot become two unrelated claims that
   * nobody compares. Aggregates never appear, since a roll-up is computed from
   * the claim set rather than stored.
   */
  readonly conflicts: readonly CrossTargetConflict[];
  /** True only if every target passed its audit and no two disagree. */
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

/**
 * Reads the claim set, deriving each claim's identity here rather than trusting
 * one to arrive.
 *
 * Identity is a function of the predicate and the subject, so asking the author
 * to write it out invites exactly the drift the function exists to prevent — and
 * the first real run confirmed it: every claim came back correct in every other
 * respect and with no `claimId` at all, because the contract's own example does
 * not show one.
 */
function readClaims(path: string): readonly Claim[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    claims?: readonly (Partial<Claim> & Pick<Claim, "predicate" | "subject" | "factIds">)[];
  };
  return (parsed.claims ?? []).map((claim) =>
    makeClaim({
      predicate: claim.predicate,
      subject: claim.subject,
      factIds: claim.factIds ?? [],
      ...(claim.qualifiers === undefined ? {} : { qualifiers: claim.qualifiers }),
      ...(claim.usedBy === undefined ? {} : { usedBy: claim.usedBy }),
    }),
  );
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
  const claimsByTarget = new Map<string, readonly Claim[]>();
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
        transcriptPath: `${targetDir}/agent-stream.jsonl`,
        ...(input.onProgress === undefined
          ? {}
          : { onProgress: (event: SkillProgress) => input.onProgress?.(target.directory, event) }),
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
    claimsByTarget.set(target.directory, [...claims]);
    outcomes.push({ target, record: record({ auditPassed: passed }), audit, blocked: null });
  }

  const conflicts = crossTargetConflicts(claimsByTarget);
  if (conflicts.length > 0) {
    writeFileSync(`${runPath}/claim-conflicts.json`, JSON.stringify(conflicts, null, 2) + "\n");
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
    conflicts,
    delivered:
      outcomes.length > 0 &&
      outcomes.every((outcome) => outcome.record.auditPassed === true) &&
      conflicts.length === 0,
  };
}

/** Every pairwise disagreement between the run's targets, each reported once. */
export function crossTargetConflicts(
  claimsByTarget: ReadonlyMap<string, readonly Claim[]>,
): readonly CrossTargetConflict[] {
  const entries = [...claimsByTarget.entries()];
  const conflicts: CrossTargetConflict[] = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftName, leftClaims] = entries[left]!;
      const [rightName, rightClaims] = entries[right]!;
      for (const conflict of qualifierConflicts(leftClaims, rightClaims)) {
        conflicts.push({ ...conflict, between: [leftName, rightName] });
      }
    }
  }
  return conflicts;
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
  if (result.conflicts.length > 0) {
    lines.push(`  ${result.conflicts.length} claim(s) described differently by two targets:`);
    for (const conflict of result.conflicts.slice(0, 5)) {
      lines.push(`    - ${conflict.claimId} "${conflict.key}": ${conflict.between.join(" vs ")}`);
    }
  }
  return lines.join("\n");
}
