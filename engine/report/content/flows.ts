/**
 * The product-manager report's flows, business rules, object states and exceptions.
 *
 * These organise the behaviour facts a reader needs to follow what the system
 * does — not only the happy path. Branches are classified by the guard the fact
 * records (proceed / reject / conditional / unknown), so rejection and
 * conditional behaviour are shown, never dropped. Object lifecycles connect
 * states to transitions; a transition with no known origin is surfaced as
 * unresolved, not inferred. Rules keep their state names, messages and citations
 * while reading in business language. Every behaviour fact in the slice is
 * printed or accounted, so nothing is silently discarded and a truth-set gap
 * points to a specific fact.
 *
 * Pure — facts in, structured content out. Nothing re-scans source, adds business
 * meaning a fact does not carry, or resolves an unknown by guessing from a name.
 */

import type { FactKind } from "../../contracts/shared-fact/families.js";
import type { SourceRef } from "../../contracts/shared-fact/provenance.js";

export const BRANCHES_SCHEMA = "module-branches.v1";
export const LIFECYCLE_SCHEMA = "lifecycle.v1";
export const RULES_SCHEMA = "module-rules.v1";

// ---------------------------------------------------------------------------
// Branches — the happy path, the rejections and the conditional behaviour.
// ---------------------------------------------------------------------------

/** How a condition/decision fact records the guard it enforces. */
export type GuardKind = "proceed" | "rejects" | "branches" | "unknown";

export interface ConditionRecord {
  readonly id: string;
  readonly subject: string;
  readonly test: string;
  readonly guard: GuardKind;
  readonly enclosing: string;
  readonly citation: SourceRef;
}

/** A decision point with more than one outcome — a conditional branch of a flow. */
export interface DecisionRecord {
  readonly id: string;
  readonly subject: string;
  readonly outcomes: readonly string[];
  readonly enclosing: string;
  readonly citation: SourceRef;
}

export type BranchOutcome = "proceed" | "reject" | "conditional" | "unknown";

export interface BranchView {
  readonly id: string;
  readonly subject: string;
  readonly test: string;
  readonly outcome: BranchOutcome;
  readonly enclosing: string;
  readonly citation: SourceRef;
}

/** Branches grouped by the flow (enclosing scope) they belong to. */
export interface FlowGroup {
  readonly enclosing: string;
  readonly branches: readonly BranchView[];
}

export interface BranchSet {
  readonly branches: readonly BranchView[];
  /** The branches organised by their enclosing flow — not a flat inventory. */
  readonly flows: readonly FlowGroup[];
  readonly counts: Readonly<Record<BranchOutcome, number>>;
  readonly total: number;
}

const OUTCOME_OF: Readonly<Record<GuardKind, BranchOutcome>> = {
  proceed: "proceed",
  rejects: "reject",
  branches: "conditional",
  unknown: "unknown",
};

/**
 * The branches of the flows, from conditions and decisions, each classified by
 * the guard its fact records (a decision is a conditional branch point). The set
 * counts proceed / reject / conditional / unknown separately, so a report built
 * from it cannot show only the happy path, and groups the branches by their
 * enclosing flow so they read as flows, not a flat list.
 */
export function renderBranches(
  conditions: readonly ConditionRecord[],
  decisions: readonly DecisionRecord[] = [],
): BranchSet {
  const fromConditions = conditions.map((c) => ({
    id: c.id,
    subject: c.subject,
    test: c.test,
    outcome: OUTCOME_OF[c.guard],
    enclosing: c.enclosing,
    citation: c.citation,
  }));
  const fromDecisions = decisions.map((d) => ({
    id: d.id,
    subject: d.subject,
    test: [...d.outcomes].join(" | "),
    outcome: "conditional" as const,
    enclosing: d.enclosing,
    citation: d.citation,
  }));

  const branches = [...fromConditions, ...fromDecisions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const counts: Record<BranchOutcome, number> = { proceed: 0, reject: 0, conditional: 0, unknown: 0 };
  for (const b of branches) counts[b.outcome] += 1;

  const byEnclosing = new Map<string, BranchView[]>();
  for (const b of branches) (byEnclosing.get(b.enclosing) ?? byEnclosing.set(b.enclosing, []).get(b.enclosing)!).push(b);
  const flows = [...byEnclosing.keys()]
    .sort()
    .map((enclosing) => ({ enclosing, branches: byEnclosing.get(enclosing)! }));

  return { branches, flows, counts, total: branches.length };
}

// ---------------------------------------------------------------------------
// Object lifecycles — states connected to transitions.
// ---------------------------------------------------------------------------

export interface EntityRecord {
  readonly entityId: string;
  readonly name: string;
  readonly citation: SourceRef;
}

export interface StateRecord {
  readonly entityId: string;
  readonly state: string;
  readonly citation: SourceRef;
}

export interface TransitionRecord {
  readonly entityId: string;
  /** null when the origin state could not be resolved — surfaced, never inferred. */
  readonly from: string | null;
  readonly to: string;
  readonly trigger: string;
  readonly citation: SourceRef;
}

export interface TransitionView {
  readonly from: string | null;
  readonly to: string;
  readonly trigger: string;
  readonly citation: SourceRef;
}

export interface LifecycleView {
  readonly entityId: string;
  readonly name: string;
  readonly states: readonly string[];
  readonly transitions: readonly TransitionView[];
  /** States with no outgoing transition. */
  readonly terminalStates: readonly string[];
  /** Transitions whose origin state is unresolved. */
  readonly unresolvedOrigins: number;
}

export interface LifecycleSet {
  readonly lifecycles: readonly LifecycleView[];
  readonly entityCount: number;
  /** Transitions actually placed in a lifecycle — what was rendered. */
  readonly transitionCount: number;
  /** Transitions whose entity is not in the input — surfaced, not counted as printed. */
  readonly danglingTransitions: number;
}

const sortStrings = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** A total-order key for a transition, citation included so distinct facts never tie. */
function transitionKey(t: { readonly from: string | null; readonly to: string; readonly trigger: string; readonly citation: SourceRef }): string {
  const c = t.citation;
  return `${t.from ?? ""}\0${t.to}\0${t.trigger}\0${c.rootName}\0${c.relPath}\0${c.startLine ?? -1}\0${c.startColumn ?? -1}`;
}

const byTransitionKey = (a: Parameters<typeof transitionKey>[0], b: Parameters<typeof transitionKey>[0]): number => {
  const ak = transitionKey(a);
  const bk = transitionKey(b);
  return ak < bk ? -1 : ak > bk ? 1 : 0;
};

/**
 * The lifecycle of each object: its states and the transitions between them.
 * Terminal states (no outgoing transition) are marked; a transition with an
 * unresolved origin is counted, not invented into a state. States seen only in a
 * transition are folded into the object's state set, so the lifecycle is closed.
 */
export function renderLifecycle(
  entities: readonly EntityRecord[],
  states: readonly StateRecord[],
  transitions: readonly TransitionRecord[],
): LifecycleSet {
  const statesByEntity = new Map<string, Set<string>>();
  const add = (entityId: string, state: string): void => {
    (statesByEntity.get(entityId) ?? statesByEntity.set(entityId, new Set()).get(entityId)!).add(state);
  };
  for (const s of states) add(s.entityId, s.state);
  for (const t of transitions) {
    if (t.from !== null) add(t.entityId, t.from);
    add(t.entityId, t.to);
  }

  const transByEntity = new Map<string, TransitionRecord[]>();
  for (const t of transitions) (transByEntity.get(t.entityId) ?? transByEntity.set(t.entityId, []).get(t.entityId)!).push(t);

  // De-dup entities by id so a duplicated record cannot double-render a lifecycle
  // or its transitions (states/transitions key on entityId; only the name differs).
  const uniqueEntities = [...new Map(entities.map((e) => [e.entityId, e])).values()];
  const lifecycles = [...uniqueEntities]
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
    .map((e) => {
      const ts = transByEntity.get(e.entityId) ?? [];
      const stateSet = sortStrings(statesByEntity.get(e.entityId) ?? []);
      const hasOutgoing = new Set(ts.filter((t) => t.from !== null).map((t) => t.from as string));
      const transitions = [...ts]
        .sort(byTransitionKey)
        .map((t) => ({ from: t.from, to: t.to, trigger: t.trigger, citation: t.citation }));
      return {
        entityId: e.entityId,
        name: e.name,
        states: stateSet,
        transitions,
        terminalStates: stateSet.filter((s) => !hasOutgoing.has(s)),
        unresolvedOrigins: ts.filter((t) => t.from === null).length,
      };
    });

  const rendered = lifecycles.reduce((n, l) => n + l.transitions.length, 0);
  return {
    lifecycles,
    entityCount: uniqueEntities.length,
    transitionCount: rendered,
    danglingTransitions: transitions.length - rendered,
  };
}

// ---------------------------------------------------------------------------
// Business rules and exceptions.
// ---------------------------------------------------------------------------

export interface RuleRecord {
  readonly id: string;
  /** A business-language statement of the rule. */
  readonly statement: string;
  readonly subject: string;
  /** The object this rule is about — when set, its state is checked against that object's lifecycle. */
  readonly entityId?: string;
  /** The state the rule references, kept verbatim. */
  readonly stateName: string | null;
  readonly message: string | null;
  readonly citation: SourceRef;
}

export interface RuleSet {
  readonly rules: readonly RuleRecord[];
  readonly ruleCount: number;
}

/** The business rules, kept in order and with their state names, messages and citations. */
export function renderRules(rules: readonly RuleRecord[]): RuleSet {
  const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { rules: sorted, ruleCount: sorted.length };
}

export type ExceptionKind = "validation" | "error-handling" | "discarded-error";

export interface ExceptionRecord {
  readonly id: string;
  readonly kind: ExceptionKind;
  readonly subject: string;
  readonly message: string | null;
  readonly citation: SourceRef;
}

export interface ExceptionSet {
  readonly exceptions: readonly ExceptionRecord[];
  readonly counts: Readonly<Record<ExceptionKind, number>>;
  readonly total: number;
}

export function renderExceptions(exceptions: readonly ExceptionRecord[]): ExceptionSet {
  const sorted = [...exceptions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts: Record<ExceptionKind, number> = { validation: 0, "error-handling": 0, "discarded-error": 0 };
  for (const e of sorted) counts[e.kind] += 1;
  return { exceptions: sorted, counts, total: sorted.length };
}

// ---------------------------------------------------------------------------
// Recovery — evidenced, or honestly unknown.
// ---------------------------------------------------------------------------

// The five recovery behaviours the content contract names — no more, so trigger
// naming cannot be stretched into business meaning the fact does not carry.
const RECOVERY_TRIGGERS: readonly string[] = ["withdraw", "cancel", "retry", "compensate", "recover"];

/** Lowercased word tokens of a trigger — camelCase and separators split — so a
 *  recovery word matches as a whole token, not a substring ("undo" ⊄ "undocumented"). */
function triggerTokens(trigger: string): Set<string> {
  return new Set(
    trigger
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter((t) => t.length > 0)
      .map((t) => t.toLowerCase()),
  );
}

export interface RecoverySet {
  readonly recoveries: readonly TransitionView[];
  /** False when no recovery behaviour is evidenced — the section is unknown, not empty. */
  readonly found: boolean;
}

/**
 * Recovery behaviours — withdraw, cancel, retry, compensate, recover — taken only
 * from transitions whose trigger names one. When none is evidenced, `found` is
 * false so the section is disclosed as unknown rather than as a confident "no
 * recovery".
 */
export function renderRecovery(transitions: readonly TransitionRecord[]): RecoverySet {
  const recoveries = transitions
    .filter((t) => {
      const tokens = triggerTokens(t.trigger);
      return RECOVERY_TRIGGERS.some((r) => tokens.has(r));
    })
    .sort(byTransitionKey)
    .map((t) => ({ from: t.from, to: t.to, trigger: t.trigger, citation: t.citation }));
  return { recoveries, found: recoveries.length > 0 };
}

// ---------------------------------------------------------------------------
// Accounting — every behaviour fact in the slice is printed or accounted.
// ---------------------------------------------------------------------------

export interface BehaviourAccounting {
  readonly slice: number;
  readonly printed: number;
  readonly unresolved: number;
  readonly complete: boolean;
}

/**
 * Reconcile what was rendered against the slice: every branch, transition, rule
 * and exception fact is printed. `complete` is true only when printed equals the
 * slice size, so a silently dropped fact is caught.
 */
export function accountBehaviour(
  sliceSize: number,
  branches: BranchSet,
  lifecycle: LifecycleSet,
  rules: RuleSet,
  exceptions: ExceptionSet,
): BehaviourAccounting {
  // transitionCount is the RENDERED count; a transition dropped for an unknown
  // entity is not counted as printed, so it makes printed < slice → incomplete.
  const printed = branches.total + lifecycle.transitionCount + rules.ruleCount + exceptions.total;
  const unresolved =
    lifecycle.lifecycles.reduce((n, l) => n + l.unresolvedOrigins, 0) + branches.counts.unknown + lifecycle.danglingTransitions;
  return { slice: sliceSize, printed, unresolved, complete: printed === sliceSize };
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

export type ContentValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

function hasCitation(ref: SourceRef): boolean {
  return ref.rootName.length > 0 && ref.relPath.length > 0;
}

export function validateBranchSet(set: BranchSet): ContentValidation {
  const reasons: string[] = [];
  const summed = set.counts.proceed + set.counts.reject + set.counts.conditional + set.counts.unknown;
  if (summed !== set.total) reasons.push(`branch outcomes sum to ${summed}, not ${set.total}`);
  for (const b of set.branches) if (!hasCitation(b.citation)) reasons.push(`branch ${b.id} has no citation`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * A rule must not contradict the lifecycle: a rule that names a state must name
 * one the object's lifecycle actually has. A named state absent from every
 * lifecycle is a contradiction, not a silent omission. (A transition's own
 * from/to states are folded into the lifecycle, so they cannot contradict it.)
 */
export function validateConsistency(rules: RuleSet, lifecycle: LifecycleSet): ContentValidation {
  const reasons: string[] = [];
  const statesByEntity = new Map(lifecycle.lifecycles.map((l) => [l.entityId, new Set(l.states)] as const));
  const allStates = new Set(lifecycle.lifecycles.flatMap((l) => l.states));
  for (const rule of rules.rules) {
    if (rule.stateName === null) continue;
    // A rule about a named object is checked against THAT object's lifecycle, so a
    // rule citing another object's state cannot pass; an unscoped rule falls back
    // to the union of all lifecycle states.
    const scope = rule.entityId !== undefined ? (statesByEntity.get(rule.entityId) ?? new Set<string>()) : allStates;
    if (!scope.has(rule.stateName)) {
      const where = rule.entityId !== undefined ? `object ${rule.entityId}` : "any lifecycle";
      reasons.push(`rule ${rule.id} names state "${rule.stateName}" that ${where} does not have`);
    }
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
  "Write for a product manager: describe the current, observable behaviour in business language.",
  "State only what the cited facts support — do not add business meaning a fact does not carry, and never present an implementation detail as a product requirement.",
  "Show the rejection and conditional branches, not only the happy path. Where a branch, activation or state origin is unresolved, say unknown rather than guess.",
  "Cite every claim by its fact id, and keep state names and messages verbatim.",
].join("\n");

export const MODULE_FLOWS_BLOCK: AuthoredBlockContract = {
  blockId: "module-flows-branches.flows",
  outputSchemaId: "module-flows.v1",
  promptId: "module-flows.v1",
  citationRule: "required",
  validatorId: "module-flows.v1",
  inputFactKinds: ["feature-flow", "condition", "decision", "guard", "route", "ui-label"],
  prompt: `Describe the module's business flows from the branches you are given — the happy path, the rejections and the conditional behaviour. Distinguish observed caller paths from endpoints whose flow explicitly says no caller was observed; the latter exist but their current use is unresolved and must not be merged into the active path.\n\n${AUDIENCE_RULES}`,
};

/**
 * A separate authored task keeps the lifecycle and business-variant contract
 * independently cacheable. It consumes the same frozen fact base as the flow
 * summary, but retains threshold, attachment, type and state evidence that a
 * compact list of major flows would otherwise flatten away.
 */
export const MODULE_LIFECYCLE_BLOCK: AuthoredBlockContract = {
  blockId: "module-flows-branches.lifecycle",
  outputSchemaId: "module-lifecycle.v1",
  promptId: "module-lifecycle.v1",
  citationRule: "required",
  validatorId: "module-lifecycle.v1",
  inputFactKinds: ["feature-flow", "scheduled-task", "state", "state-transition", "value-set", "condition", "decision", "guard", "business-rule", "validation-rule", "source-excerpt", "ui-label"],
  prompt: `Build the module's evidenced end-to-end business lifecycle and its materially different business variants. Show creation or entry, validation, submission, each approval or processing stage, success/rejection, cancellation/withdrawal/deletion, scheduled transitions and recovery when evidenced. Preserve distinct type-specific rules, numeric or time thresholds, balance/attachment requirements, role-dependent approval levels and status changes; do not reduce them to a generic validation step. A route whose flow explicitly says no caller was observed exists, but is not evidence of the active lifecycle: separate it as caller-unresolved rather than merging it with observed caller paths. If a state origin or outcome is not established, label it unknown instead of inferring it.\n\n${AUDIENCE_RULES}`,
};

export const MODULE_RULES_NOTES_BLOCK: AuthoredBlockContract = {
  blockId: "module-objects-rules-states.notes",
  outputSchemaId: "module-rules-notes.v1",
  promptId: "module-rules-notes.v1",
  citationRule: "required",
  validatorId: "module-rules-notes.v1",
  inputFactKinds: ["state", "state-transition", "value-set", "business-rule", "validation-rule", "ui-label"],
  prompt: `Explain the object lifecycles, rules, states and exceptions you are given, keeping state names and messages verbatim.\n\n${AUDIENCE_RULES}`,
};

export const MODULE_RECOVERY_BLOCK: AuthoredBlockContract = {
  blockId: "module-recovery.notes",
  outputSchemaId: "module-recovery.v1",
  promptId: "module-recovery.v1",
  citationRule: "required",
  validatorId: "module-recovery.v1",
  inputFactKinds: ["state-transition", "condition", "guard", "ui-label"],
  prompt: `Describe the withdraw, cancel, retry, compensate and recover behaviours you are given. If none is evidenced, say the recovery behaviour is unknown.\n\n${AUDIENCE_RULES}`,
};

export const PM_FLOWS_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [
  MODULE_FLOWS_BLOCK,
  MODULE_LIFECYCLE_BLOCK,
  MODULE_RULES_NOTES_BLOCK,
  MODULE_RECOVERY_BLOCK,
];
