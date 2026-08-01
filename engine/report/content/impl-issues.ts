/**
 * The developer report's tests, change impact, technical fragility and gaps.
 *
 * This renders the evidence a developer needs to judge risk of change — without
 * ever crossing into subjective business risk or priority. Test relations are
 * summarised as repository evidence, never a proof of production correctness.
 * Change impact is bounded to what the resolved graph reaches, with truncation and
 * unresolved boundaries counted separately, never promised as complete. Technical
 * fragility is only what a fact supports, each finding tagged observed /
 * bounded-inference / unknown and citing its evidence. The known problems are the
 * shared ledger (PI-14) projected for a developer audience — the same problem ids
 * and citations as the product report, so nothing is re-minted or made to diverge.
 *
 * There is no severity ranking, priority, remediation or roadmap field anywhere: a
 * subjective-priority input cannot be represented, so it is rejected by construction.
 *
 * Pure — facts in, structured content out. Nothing re-scans source, invents an
 * edge, or turns a name into evidence of fragility.
 */

import type { FactKind } from "../../contracts/shared-fact/families.js";
import type { SourceRef } from "../../contracts/shared-fact/provenance.js";
// Reuse the product report's problem-ledger projection so the dev report carries
// the SAME problem ids, citations and impact — consistency by construction.
export {
  type ProblemView,
  type ProblemLedgerView,
  renderProblemLedger,
  validateProblemLedger,
} from "./effects.js";

export const IMPL_ISSUES_SCHEMA = "impl-issues.v1";
export const MODULE_IMPL_ISSUES_SCHEMA = "module-impl-issues.v1";

function hasCitation(ref: SourceRef): boolean {
  return ref.rootName.length > 0 && ref.relPath.length > 0;
}

const byId = <T extends { readonly id: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const sortStrings = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

// ---------------------------------------------------------------------------
// Test evidence — repository test relations, not a correctness proof.
// ---------------------------------------------------------------------------

export interface TestRelationRecord {
  readonly id: string;
  readonly testSymbolId: string;
  readonly targetSymbolId: string;
  readonly relation: "covers" | "exercises";
  readonly citation: SourceRef;
}

export interface TestEvidence {
  readonly relations: readonly TestRelationRecord[];
  /** Target symbols with at least one test relation. */
  readonly covered: readonly string[];
  /** Target symbols in scope with no test relation. */
  readonly uncovered: readonly string[];
  readonly coveredCount: number;
  /** The scope denominator — the target symbols this coverage is measured against. */
  readonly targetCount: number;
}

/**
 * Summarise the test relations over the in-scope target symbols. Coverage is the
 * count of targets with a test relation over the target denominator — repository
 * evidence of what is exercised, not a claim that behaviour is correct.
 */
export function renderTestEvidence(relations: readonly TestRelationRecord[], targetSymbolIds: readonly string[]): TestEvidence {
  const targets = new Set(targetSymbolIds);
  const coveredSet = new Set(relations.map((r) => r.targetSymbolId).filter((t) => targets.has(t)));
  const covered = sortStrings(coveredSet);
  return {
    relations: byId(relations),
    covered,
    uncovered: sortStrings([...targets].filter((t) => !coveredSet.has(t))),
    coveredCount: covered.length,
    targetCount: targets.size,
  };
}

// ---------------------------------------------------------------------------
// Change impact — bounded to what the resolved graph reaches.
// ---------------------------------------------------------------------------

export interface ImpactEdge {
  readonly from: string;
  readonly to: string;
  readonly resolution: "resolved" | "unresolved";
}

export interface ChangeImpact {
  readonly changed: readonly string[];
  /** Symbols reachable from the changed set over resolved edges (excludes the seeds). */
  readonly reachable: readonly string[];
  readonly reachableCount: number;
  /** Unresolved edges leaving the reached set — the boundary the impact cannot cross. */
  readonly unresolvedBoundary: number;
  /** True when traversal was cut off — the impact is a lower bound, not complete. */
  readonly truncated: boolean;
}

/**
 * The change impact: the symbols reachable from the changed set over resolved
 * edges only. Unresolved edges at the frontier are counted as a boundary, not
 * crossed; a truncated traversal is flagged so the impact is read as a lower
 * bound. No edge outside the supplied graph is followed.
 */
export function renderChangeImpact(
  changed: readonly string[],
  edges: readonly ImpactEdge[],
  truncated: boolean,
): ChangeImpact {
  const resolvedAdj = new Map<string, string[]>();
  let unresolvedBoundary = 0;
  const seeds = new Set(changed);
  for (const e of edges) {
    if (e.resolution === "resolved") {
      (resolvedAdj.get(e.from) ?? resolvedAdj.set(e.from, []).get(e.from)!).push(e.to);
    }
  }

  const reached = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of resolvedAdj.get(node) ?? []) {
      if (!reached.has(next) && !seeds.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  // Count unresolved edges leaving any reached-or-seed node — the boundary.
  const inScope = new Set([...seeds, ...reached]);
  for (const e of edges) if (e.resolution === "unresolved" && inScope.has(e.from)) unresolvedBoundary += 1;

  return {
    changed: sortStrings(changed),
    reachable: sortStrings(reached),
    reachableCount: reached.size,
    unresolvedBoundary,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Technical fragility — evidenced, typed, never a subjective ranking.
// ---------------------------------------------------------------------------

/** What kind of claim a finding is — never a severity or priority. */
export type FindingType = "observed" | "bounded-inference" | "unknown";

export type FragilityKind =
  | "high-coupling"
  | "critical-single-entry"
  | "unresolved-relation"
  | "weak-test-association"
  | "provider-failure";

export interface FragilityFinding {
  readonly id: string;
  readonly kind: FragilityKind;
  readonly findingType: FindingType;
  readonly subject: string;
  /** The fact/diagnostic ids this finding rests on — at least one. */
  readonly evidenceIds: readonly string[];
  readonly scope: string;
  /** What this finding does NOT let a reader infer — the bounded claim. */
  readonly nonInferableBoundary: string;
  readonly citation: SourceRef;
}

export interface FragilitySet {
  readonly findings: readonly FragilityFinding[];
  readonly byKind: Readonly<Record<FragilityKind, number>>;
  readonly byFindingType: Readonly<Record<FindingType, number>>;
  readonly total: number;
}

export function renderFragility(records: readonly FragilityFinding[]): FragilitySet {
  const findings = byId(records);
  const byKind: Record<FragilityKind, number> = {
    "high-coupling": 0,
    "critical-single-entry": 0,
    "unresolved-relation": 0,
    "weak-test-association": 0,
    "provider-failure": 0,
  };
  const byFindingType: Record<FindingType, number> = { observed: 0, "bounded-inference": 0, unknown: 0 };
  for (const f of findings) {
    byKind[f.kind] += 1;
    byFindingType[f.findingType] += 1;
  }
  return { findings, byKind, byFindingType, total: findings.length };
}

// ---------------------------------------------------------------------------
// Gaps — affected scope, missing capability, next investigation entry.
// ---------------------------------------------------------------------------

export interface GapFinding {
  readonly id: string;
  readonly affectedScope: string;
  readonly missingCapability: string;
  readonly nextStep: string;
  readonly citation: SourceRef | null;
}

export interface GapSet {
  readonly gaps: readonly GapFinding[];
  readonly count: number;
}

export function renderGaps(records: readonly GapFinding[]): GapSet {
  const gaps = byId(records);
  return { gaps, count: gaps.length };
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

export type ContentValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

export function validateTestEvidence(evidence: TestEvidence): ContentValidation {
  const reasons: string[] = [];
  if (evidence.coveredCount !== evidence.covered.length) reasons.push("covered count mismatch");
  if (evidence.coveredCount > evidence.targetCount) reasons.push(`covered ${evidence.coveredCount} exceeds targets ${evidence.targetCount}`);
  if (evidence.relations.length !== new Set(evidence.relations.map((r) => r.id)).size) reasons.push("duplicate test relation");
  for (const r of evidence.relations) if (!hasCitation(r.citation)) reasons.push(`test relation ${r.id} has no citation`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Every fragility finding cites at least one fact, is typed observed /
 * bounded-inference / unknown, states its non-inferable boundary, and is located.
 * The counts reconcile. Because the record carries no severity or priority field,
 * a subjective ranking cannot be present to validate — it is rejected at the type.
 */
export function validateFragility(set: FragilitySet): ContentValidation {
  const reasons: string[] = [];
  const byKind = Object.values(set.byKind).reduce((a, b) => a + b, 0);
  const byType = set.byFindingType.observed + set.byFindingType["bounded-inference"] + set.byFindingType.unknown;
  if (byKind !== set.total) reasons.push(`fragility kinds sum to ${byKind}, not ${set.total}`);
  if (byType !== set.total) reasons.push(`finding types sum to ${byType}, not ${set.total}`);
  if (set.findings.length !== new Set(set.findings.map((f) => f.id)).size) reasons.push("duplicate fragility finding");
  for (const f of set.findings) {
    if (f.evidenceIds.length === 0) reasons.push(`fragility ${f.id} cites no fact`);
    if (f.nonInferableBoundary.length === 0) reasons.push(`fragility ${f.id} states no non-inferable boundary`);
    if (!hasCitation(f.citation)) reasons.push(`fragility ${f.id} has no citation`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateChangeImpact(impact: ChangeImpact): ContentValidation {
  const reasons: string[] = [];
  if (impact.reachableCount !== impact.reachable.length) reasons.push("reachable count mismatch");
  // The impact must not claim a changed seed as its own downstream reach.
  const seeds = new Set(impact.changed);
  for (const r of impact.reachable) if (seeds.has(r)) reasons.push(`reachable includes the changed seed ${r}`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateGaps(set: GapSet): ContentValidation {
  const reasons: string[] = [];
  for (const g of set.gaps) {
    if (g.affectedScope.length === 0) reasons.push(`gap ${g.id} has no affected scope`);
    if (g.missingCapability.length === 0) reasons.push(`gap ${g.id} has no missing capability`);
    if (g.nextStep.length === 0) reasons.push(`gap ${g.id} has no next step`);
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

const DEVELOPER_RULES = [
  "Write for a developer: cite every claim by its fact/diagnostic id, and keep real symbol names and source locations verbatim.",
  "Describe test evidence as repository coverage, not proof of production correctness. Bound change impact to the resolved graph; count truncation and unresolved separately and never promise completeness.",
  "Tag each finding observed / bounded-inference / unknown, and state what it does NOT let a reader infer.",
  "Do not judge business risk, product priority, future needs or team capability; do not produce a remediation, a severity ranking or a roadmap.",
].join("\n");

/** project-impl-issues.impact — the bounded change-impact narrative. */
export const CHANGE_IMPACT_BLOCK: AuthoredBlockContract = {
  blockId: "project-impl-issues.impact",
  outputSchemaId: "change-impact.v1",
  promptId: "change-impact.v1",
  citationRule: "required",
  validatorId: "change-impact.v1",
  inputFactKinds: ["diagnostic"],
  prompt: `Describe the change impact and affected areas from the reachable graph and diagnostics you are given, staying within the resolved boundary.\n\n${DEVELOPER_RULES}`,
};

/** module-impl-issues.impact — the module change-impact narrative. */
export const MODULE_CHANGE_IMPACT_BLOCK: AuthoredBlockContract = {
  blockId: "module-impl-issues.impact",
  outputSchemaId: "module-change-impact.v1",
  promptId: "module-change-impact.v1",
  citationRule: "required",
  validatorId: "module-change-impact.v1",
  inputFactKinds: ["diagnostic"],
  prompt: `Describe the module's change impact, affected areas and technical fragility from the facts you are given, staying within the module's evidenced boundary.\n\n${DEVELOPER_RULES}`,
};

export const DEV_IMPL_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [CHANGE_IMPACT_BLOCK, MODULE_CHANGE_IMPACT_BLOCK];

/** The deterministic renderer → catalog block-id bindings, verifiable against the catalog. */
export const IMPL_SCHEMA_BLOCKS: readonly { readonly blockId: string; readonly outputSchemaId: string }[] = [
  { blockId: "project-impl-issues.diagnostics", outputSchemaId: IMPL_ISSUES_SCHEMA },
  { blockId: "module-impl-issues.diagnostics", outputSchemaId: MODULE_IMPL_ISSUES_SCHEMA },
];
