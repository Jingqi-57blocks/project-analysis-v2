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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  indexClaims,
  makeClaim,
  qualifierConflicts,
  type Claim,
  type QualifierConflict,
} from "../contracts/claim/index.js";
import { authorableChapters } from "../contracts/report/chapters.js";
import { buildFactPack, type FactPack } from "../kb/fact-pack.js";
import { pruneFactPackBulk, writeFactPack } from "../kb/fact-pack-io.js";
import { evaluateGate, explainVerdict } from "../kb/generation-gate.js";
import { auditReport, readInventory, type AuditResult } from "./kb-audit.js";
import type { PlannedTarget, ReportPlan } from "./orchestrate.js";
import {
  allocateRunDirectory,
  buildManifest,
  openRunDirectory,
  writeManifest,
  type RunManifest,
  type TargetRecord,
} from "./run-identity.js";
import type { SkillProgress, SkillRunner } from "./skill-port.js";
import { MINIMUM_TIER } from "./stability.js";
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
  /**
   * How many chapters may be authored at once.
   *
   * Chapters are independent given the claim set, so this is a throughput knob
   * rather than a correctness one — kept modest by default because the limit
   * that bites first is the model's, not the machine's.
   */
  readonly chapterConcurrency?: number;
  /**
   * Continue an earlier run instead of starting one.
   *
   * A full request is many model calls, and losing all of them to one
   * interruption is the difference between a retry and a rerun. Anything already
   * written — a claim set, a finished chapter — is kept and skipped, so a resumed
   * run costs only what is genuinely left.
   */
  readonly resumeRunId?: string;
  /**
   * How many targets to author at once.
   *
   * Concurrency buys wall clock and costs nothing extra — until a quota window is
   * the binding constraint, at which point it is actively harmful: two targets
   * racing through the same budget both stop half-finished, where one at a time
   * would have finished the first. Set to 1 when the budget is what might run out.
   */
  readonly targetConcurrency?: number;
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
  /** Set when the run was authored below the tier the trial established as a floor. */
  readonly belowTierFloor: boolean;
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
  const { runId, path: runPath } =
    input.resumeRunId === undefined
      ? allocateRunDirectory(input.outputRoot, input.plan.runLabel, input.instant)
      : openRunDirectory(input.outputRoot, input.resumeRunId);
  const scratchDir = `${runPath}/scratch`;
  mkdirSync(scratchDir, { recursive: true });
  const inventory = readInventory(input.store, input.snapshotId);
  /**
   * Packs in flight, keyed by `packKey`.
   *
   * A promise rather than a path: with targets running concurrently, caching the
   * result would let two targets that share a pack both find nothing cached and
   * both cut it, writing over each other. Caching the work means the first one
   * cuts and the rest wait.
   */
  const packDirs = new Map<string, Promise<string>>();
  const claimsByTarget = new Map<string, readonly Claim[]>();
  const outcomes: TargetOutcome[] = [];
  let modelTier = "unknown";

  const runTarget = async (target: PlannedTarget): Promise<TargetOutcome> => {
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
      return { target, record: record({}), audit: null, blocked: explainVerdict(gate) };
    }

    let cutting = packDirs.get(target.packKey);
    if (cutting === undefined) {
      const directory = `${runPath}/packs/${target.packKey.replace(/[^\w.-]+/g, "-")}`;
      cutting = Promise.resolve().then(() => {
        writeFactPack(pack, directory);
        return directory;
      });
      packDirs.set(target.packKey, cutting);
    }
    const packDir = await cutting;

    const targetDir = `${runPath}/${target.directory}`;
    mkdirSync(targetDir, { recursive: true });
    const claimsPath = `${targetDir}/claims.json`;
    const viewPath = `${targetDir}/report.md`;

    const chapterDir = `${targetDir}/chapters`;
    mkdirSync(chapterDir, { recursive: true });
    const chapters = authorableChapters(target.spec);
    const progress =
      input.onProgress === undefined
        ? {}
        : { onProgress: (event: SkillProgress) => input.onProgress?.(target.directory, event) };

    try {
      // One pass over the whole pack. Splitting this would let two workers each
      // invent a wording for the same finding; the pack, not the chapter list,
      // is what keeps the conclusions one set.
      //
      // Skipped when the claim set survives from an earlier attempt: it is the
      // single most expensive call in the run, and redoing it would also change
      // the claims the finished chapters were written against.
      if (existsSync(claimsPath)) {
        input.onProgress?.(target.directory, { elapsedMs: 0, kind: "start", detail: "claims already written, kept" });
      } else {
        const claimsOutcome = await input.runSkill({
          phase: "claims",
          packDir,
          specId: target.spec.id,
          language: input.plan.language,
          claimsPath,
          viewPath,
          repoRoot: input.repoRoot,
          scratchDir,
          transcriptPath: `${targetDir}/agent-stream-claims.jsonl`,
          ...progress,
        });
        modelTier = claimsOutcome.modelTier;
      }

      // Chapters run concurrently. Safe only because they share one claim set,
      // so two of them cannot contradict each other however independently
      // they were written.
      const pending = chapters.filter((chapter) => !existsSync(`${chapterDir}/${chapter.slug}.md`));
      if (pending.length < chapters.length) {
        input.onProgress?.(target.directory, {
          elapsedMs: 0,
          kind: "start",
          detail: `${chapters.length - pending.length} chapter(s) already written, kept`,
        });
      }
      await inBatches(pending, input.chapterConcurrency ?? 4, async (chapter) => {
        await input.runSkill({
          phase: "chapter",
          chapter: { ...chapter, outputPath: `${chapterDir}/${chapter.slug}.md` },
          packDir,
          specId: target.spec.id,
          language: input.plan.language,
          claimsPath,
          viewPath,
          repoRoot: input.repoRoot,
          scratchDir,
          transcriptPath: `${targetDir}/agent-stream-${chapter.slug}.jsonl`,
          ...progress,
        });
      });
    } catch (error) {
      return {
        target,
        record: record({}),
        audit: null,
        blocked: error instanceof Error ? error.message : String(error),
      };
    }

    const missing = chapters.filter((chapter) => !existsSync(`${chapterDir}/${chapter.slug}.md`));
    if (missing.length > 0) {
      return {
        target,
        record: record({}),
        audit: null,
        blocked: `chapters not written: ${missing.map((chapter) => chapter.number).join(", ")}`,
      };
    }
    writeFileSync(
      viewPath,
      chapters
        .map((chapter) => readFileSync(`${chapterDir}/${chapter.slug}.md`, "utf8").trim())
        .join("\n\n"),
    );

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
    return { target, record: record({ auditPassed: passed }), audit, blocked: null };
  };

  // Targets run concurrently. They are independent by construction — each reads
  // its own pack and produces its own claim set, and the cross-document check
  // runs after all of them — so making them queue only spends wall clock.
  const attempt = async (target: PlannedTarget): Promise<TargetOutcome> => {
    try {
      return await runTarget(target);
    } catch (error) {
      return {
        target,
        record: {
          scope: target.scope,
          audience: target.audience,
          module: target.module?.structuralName ?? null,
          specId: target.spec.id,
          specVersion: target.spec.version,
          directory: target.directory,
          auditPassed: null,
        },
        audit: null,
        blocked: error instanceof Error ? error.message : String(error),
      } satisfies TargetOutcome;
    }
  };

  const produced: TargetOutcome[] = [];
  const limit = input.targetConcurrency ?? input.plan.targets.length;
  if (limit <= 1) {
    for (const target of input.plan.targets) {
      const outcome = await attempt(target);
      produced.push(outcome);
      // A spent budget will not refill within this run, so continuing would only
      // convert the remaining targets into further empty directories.
      if (outcome.blocked !== null && /quota exhausted/i.test(outcome.blocked)) break;
    }
  } else {
    const queue = [...input.plan.targets];
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          produced.push(await attempt(next));
        }
      }),
    );
  }
  outcomes.push(...produced);

  // The packs have served their purpose once every target has been authored.
  // A run that produced nothing keeps them, because that is when the rows are
  // worth having; a run that succeeded keeps only the index, which is what a
  // later reader needs to interpret the coverage statements.
  if (outcomes.some((outcome) => outcome.blocked === null)) {
    for (const cutting of packDirs.values()) pruneFactPackBulk(await cutting);
    // Intermediates go the same way as the pack bulk, and for the same reason:
    // they are reproducible, they are large, and a run kept forever should hold
    // what someone will read, not what the author needed along the way.
    rmSync(scratchDir, { recursive: true, force: true });
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

  // The floor is a floor because the failure below it is fabrication, not lower
  // quality — so a sub-floor run is not a deliverable however clean its audit
  // looks. `default` means the host chose, which is the normal path.
  const belowTierFloor = modelTier !== "default" && modelTier !== MINIMUM_TIER && modelTier === "haiku";

  return {
    runId,
    runPath,
    manifest,
    outcomes,
    conflicts,
    belowTierFloor,
    delivered:
      outcomes.length > 0 &&
      outcomes.every((outcome) => outcome.record.auditPassed === true) &&
      conflicts.length === 0 &&
      !belowTierFloor,
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

/**
 * Runs `work` over `items` with at most `limit` in flight.
 *
 * A plain `Promise.all` over thirteen chapters would open thirteen model calls
 * at once; the limit that bites first is the model's, not the machine's.
 */
async function inBatches<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  });
  await Promise.all(workers);
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
  if (result.belowTierFloor) {
    lines.push(`  authored below the ${MINIMUM_TIER} floor — not a deliverable, whatever the audit says`);
  }
  if (result.conflicts.length > 0) {
    lines.push(`  ${result.conflicts.length} claim(s) described differently by two targets:`);
    for (const conflict of result.conflicts.slice(0, 5)) {
      lines.push(`    - ${conflict.claimId} "${conflict.key}": ${conflict.between.join(" vs ")}`);
    }
  }
  return lines.join("\n");
}
