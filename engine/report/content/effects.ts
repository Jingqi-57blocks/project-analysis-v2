/**
 * The product-manager report's notifications, integrations, unknowns and coverage.
 *
 * This renders the system's outward behaviour and the accounting around it. An
 * effect (a notification, an outbound call, a data write) is shown with the one
 * distinction the contract insists on: whether it is only *declared in config*,
 * *reachable on a code path*, or of *unconfirmed production activation* — source
 * cannot prove a thing is actually enabled in production, so it is never claimed
 * to be. An external dependency is not conflated with an observed call.
 *
 * Coverage rows carry their denominator bucket, so every number traces back to
 * what was counted; a not-applicable or unknown row carries a readable reason.
 * The problem ledger is the shared one the pipeline compiled (PI-14): this
 * projects it for a product audience keeping the same problem ids, citations and
 * bounded impact — it does not mint a new id, and it never rewrites an unknown,
 * an unsupported capability or a provider failure into a risk.
 *
 * Pure — facts in, structured content out. No subjective priority, remediation,
 * future requirement or roadmap is produced.
 */

import type { SourceRef } from "../../contracts/shared-fact/provenance.js";
import type { FactKind } from "../../contracts/shared-fact/families.js";
import {
  type CoverageState,
  type DenominatorBucket,
  bucketOf,
  countsTowardDenominator,
} from "../../contracts/shared-fact/applicability.js";
import type { ProblemRecord, ProblemResolution } from "../../contracts/report/pipeline.js";
import type { Scope } from "../../contracts/report/target.js";

export const EFFECTS_SCHEMA = "module-effects.v1";
export const COVERAGE_SCHEMA = "coverage.v1";
export const PROBLEM_LEDGER_SCHEMA = "problem-ledger.v1";

function scopeId(scope: Scope): string {
  return scope.kind === "project" ? "project" : `module:${scope.moduleId}`;
}

const sortById = <T extends { readonly id: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// ---------------------------------------------------------------------------
// Outbound effects — notifications, integrations, data impact.
// ---------------------------------------------------------------------------

/**
 * How far a fact can vouch for an effect being live. `declared-config` is a
 * config entry alone; `reachable` is an effect on a reachable code path;
 * `unconfirmed-production` is one whose production activation source cannot prove.
 */
export type ActivationState = "declared-config" | "reachable" | "unconfirmed-production";

export type EffectKind = "notification" | "outbound-call" | "data-access";

export interface EffectRecord {
  readonly id: string;
  readonly kind: EffectKind;
  /** The channel, external system or entity the effect targets. */
  readonly target: string;
  readonly operation: string;
  readonly activation: ActivationState;
  /** True when the target is an external dependency, distinct from an observed call to it. */
  readonly external: boolean;
  readonly citation: SourceRef;
}

export interface EffectSet {
  readonly effects: readonly EffectRecord[];
  readonly counts: Readonly<Record<EffectKind, number>>;
  readonly byActivation: Readonly<Record<ActivationState, number>>;
  readonly externalCount: number;
  readonly total: number;
}

/**
 * The outbound effects, each with its kind, target, activation state and whether
 * the target is external. Deterministic (sorted by id); counts by kind and by
 * activation, so a reader can tell a declared-but-unconfirmed integration from an
 * observed call, and an external dependency from an internal effect.
 */
export function renderEffects(records: readonly EffectRecord[]): EffectSet {
  const effects = sortById(records);
  const counts: Record<EffectKind, number> = { notification: 0, "outbound-call": 0, "data-access": 0 };
  const byActivation: Record<ActivationState, number> = { "declared-config": 0, reachable: 0, "unconfirmed-production": 0 };
  let externalCount = 0;
  for (const e of effects) {
    counts[e.kind] += 1;
    byActivation[e.activation] += 1;
    if (e.external) externalCount += 1;
  }
  return { effects, counts, byActivation, externalCount, total: effects.length };
}

// ---------------------------------------------------------------------------
// Coverage — every number traces to its denominator.
// ---------------------------------------------------------------------------

export interface CoverageInputRow {
  readonly dimension: string;
  readonly state: CoverageState;
  /** A readable reason, required when the state is not a plain found/not-found. */
  readonly reason: string;
}

export interface CoverageRow {
  readonly dimension: string;
  readonly state: CoverageState;
  readonly bucket: DenominatorBucket;
  readonly inDenominator: boolean;
  readonly reason: string;
}

export interface CoverageReport {
  readonly rows: readonly CoverageRow[];
  /** Rows that count toward the denominator (everything but not-applicable). */
  readonly denominator: number;
  readonly covered: number;
  /** Rows in a capability or evidence gap bucket. */
  readonly gaps: number;
  readonly notApplicable: number;
}

/**
 * The coverage table: each dimension mapped to its denominator bucket, with the
 * denominator, covered and gap counts derived from the buckets so every number
 * traces back to the rows it came from. not-applicable is the only bucket outside
 * the denominator, exactly as the shared coverage contract defines.
 */
export function renderCoverage(input: readonly CoverageInputRow[]): CoverageReport {
  const rows = [...input]
    .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0))
    .map((r) => {
      const bucket = bucketOf(r.state);
      return { dimension: r.dimension, state: r.state, bucket, inDenominator: countsTowardDenominator(bucket), reason: r.reason };
    });

  return {
    rows,
    denominator: rows.filter((r) => r.inDenominator).length,
    covered: rows.filter((r) => r.bucket === "covered").length,
    gaps: rows.filter((r) => r.bucket === "capability-gap" || r.bucket === "evidence-gap").length,
    notApplicable: rows.filter((r) => r.bucket === "not-applicable").length,
  };
}

// ---------------------------------------------------------------------------
// The shared problem ledger, projected for a product audience.
// ---------------------------------------------------------------------------

export interface ProblemView {
  /** The pipeline's problem id, reused — never a new one. */
  readonly problemId: string;
  readonly scope: string;
  readonly category: string;
  readonly resolution: ProblemResolution;
  readonly confidence: string;
  readonly evidenceIds: readonly string[];
  readonly citations: readonly string[];
  readonly impactBoundary: string;
}

export interface ProblemLedgerView {
  readonly problems: readonly ProblemView[];
  readonly count: number;
}

/**
 * Project the shared problem ledger (PI-14) for a product audience. Every field a
 * known problem must carry — id, scope, category, resolution, confidence, evidence
 * and diagnostic ids, citation and bounded impact — is passed through with the
 * same problem id. It adds no risk, priority or remediation: an unknown or a
 * provider failure is not a finding here unless it already was one.
 */
export function renderProblemLedger(records: readonly ProblemRecord[]): ProblemLedgerView {
  const problems = [...records]
    .sort((a, b) => (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0))
    .map((p) => ({
      problemId: p.problemId,
      scope: scopeId(p.scope),
      category: p.category,
      resolution: p.resolution,
      confidence: p.confidence,
      evidenceIds: p.evidenceIds,
      citations: p.citations,
      impactBoundary: p.impactBoundary,
    }));
  return { problems, count: problems.length };
}

// ---------------------------------------------------------------------------
// Open / unresolved questions — surfaced, never rewritten as requirements.
// ---------------------------------------------------------------------------

export type OpenQuestionCode = "unknown" | "unresolved" | "unsupported" | "truncated" | "failed";

export interface OpenQuestion {
  readonly id: string;
  readonly code: OpenQuestionCode;
  readonly affectedScope: string;
  /** Where to look next to resolve it — an investigation entry point, not a fix. */
  readonly nextStep: string;
}

export interface OpenQuestionSet {
  readonly questions: readonly OpenQuestion[];
  readonly count: number;
}

/**
 * The open questions, each with its evidence-state code, the scope it affects and
 * a next investigation entry point. They summarise what is unresolved; they are
 * not rephrased into requirements, priorities or fixes.
 */
export function renderOpenQuestions(items: readonly OpenQuestion[]): OpenQuestionSet {
  return { questions: sortById(items), count: items.length };
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

export type ContentValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

function hasCitation(ref: SourceRef): boolean {
  return ref.rootName.length > 0 && ref.relPath.length > 0;
}

export function validateEffects(set: EffectSet): ContentValidation {
  const reasons: string[] = [];
  const summed = set.counts.notification + set.counts["outbound-call"] + set.counts["data-access"];
  if (summed !== set.total) reasons.push(`effect kinds sum to ${summed}, not ${set.total}`);
  const byAct = set.byActivation["declared-config"] + set.byActivation.reachable + set.byActivation["unconfirmed-production"];
  if (byAct !== set.total) reasons.push(`activation states sum to ${byAct}, not ${set.total}`);
  for (const e of set.effects) if (!hasCitation(e.citation)) reasons.push(`effect ${e.id} has no citation`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateCoverage(report: CoverageReport): ContentValidation {
  const reasons: string[] = [];
  const inDenom = report.rows.filter((r) => r.inDenominator).length;
  if (inDenom !== report.denominator) reasons.push(`denominator ${report.denominator} ≠ ${inDenom} in-denominator rows`);
  if (report.covered > report.denominator) reasons.push(`covered ${report.covered} exceeds denominator ${report.denominator}`);
  // A not-applicable or unknown/unsupported/failed/truncated row must give a reason.
  for (const r of report.rows) {
    if (r.state !== "found" && r.state !== "not-found" && r.reason.length === 0) {
      reasons.push(`${r.dimension} is ${r.state} with no reason`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateProblemLedger(view: ProblemLedgerView, records: readonly ProblemRecord[]): ContentValidation {
  const reasons: string[] = [];
  const knownIds = new Set(records.map((p) => p.problemId));
  for (const p of view.problems) {
    if (!knownIds.has(p.problemId)) reasons.push(`problem ${p.problemId} is not from the shared ledger`);
    if (p.scope.length === 0) reasons.push(`problem ${p.problemId} has no scope`);
    if (p.category.length === 0) reasons.push(`problem ${p.problemId} has no category`);
    if (p.evidenceIds.length === 0) reasons.push(`problem ${p.problemId} has no evidence`);
    if (p.impactBoundary.length === 0) reasons.push(`problem ${p.problemId} has no impact boundary`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Authored-block contracts.
// ---------------------------------------------------------------------------

export interface AuthoredBlockContract {
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly promptId: string;
  readonly citationRule: "required";
  readonly validatorId: string;
  readonly inputFactKinds: readonly FactKind[];
  readonly prompt: string;
}

const AUDIENCE_RULES = [
  "Write for a product manager: describe the current, observable outward behaviour in business language.",
  "State a notification channel, trigger, receiver or external system only where a fact declares it — never guess.",
  "Keep a declared configuration, a reachable call and an unconfirmed production activation distinct; do not claim production state source cannot prove.",
  "Do not turn an unknown, an unsupported capability or a provider failure into a risk, a priority, a remediation or a future requirement.",
  "Cite every claim by its fact id.",
].join("\n");

/** module-notifications-data.notes — the outbound-behaviour explanation. */
export const MODULE_EFFECTS_NOTES_BLOCK: AuthoredBlockContract = {
  blockId: "module-notifications-data.notes",
  outputSchemaId: "module-effects-notes.v1",
  promptId: "module-effects-notes.v1",
  citationRule: "required",
  validatorId: "module-effects-notes.v1",
  inputFactKinds: ["outbound-call"],
  prompt: `Explain the notifications, integrations and data impact you are given, keeping declared config, reachable calls and unconfirmed production distinct.\n\n${AUDIENCE_RULES}`,
};

/** known-issues.impact — the shared problem ledger's impact prose (product audience). */
export const KNOWN_ISSUES_IMPACT_BLOCK: AuthoredBlockContract = {
  blockId: "known-issues.impact",
  outputSchemaId: "problem-impact.v1",
  promptId: "problem-impact.v1",
  citationRule: "required",
  validatorId: "problem-impact.v1",
  inputFactKinds: ["diagnostic"],
  prompt: `Explain the impact of each known problem you are given, keeping its problem id, evidence and bounded impact. Do not add a priority, a remediation or a future requirement.\n\n${AUDIENCE_RULES}`,
};

export const PM_EFFECTS_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [
  MODULE_EFFECTS_NOTES_BLOCK,
  KNOWN_ISSUES_IMPACT_BLOCK,
];
