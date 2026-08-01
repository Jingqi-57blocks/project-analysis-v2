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
export const EXCEPTIONS_SCHEMA = "exceptions.v1";

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

export type BranchOutcome = "proceed" | "reject" | "conditional" | "unknown";

export interface BranchView {
  readonly id: string;
  readonly subject: string;
  readonly test: string;
  readonly outcome: BranchOutcome;
  readonly enclosing: string;
  readonly citation: SourceRef;
}

export interface BranchSet {
  readonly branches: readonly BranchView[];
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
 * The branches of a flow, each classified by the guard its fact records. The set
 * counts proceed / reject / conditional / unknown separately, so a report built
 * from it cannot show only the happy path — a rejection or a conditional branch
 * is a first-class row with its own citation.
 */
export function renderBranches(conditions: readonly ConditionRecord[]): BranchSet {
  const branches = [...conditions]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({ id: c.id, subject: c.subject, test: c.test, outcome: OUTCOME_OF[c.guard], enclosing: c.enclosing, citation: c.citation }));

  const counts: Record<BranchOutcome, number> = { proceed: 0, reject: 0, conditional: 0, unknown: 0 };
  for (const b of branches) counts[b.outcome] += 1;
  return { branches, counts, total: branches.length };
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
  readonly transitionCount: number;
}

const sortStrings = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

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

  const lifecycles = [...entities]
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
    .map((e) => {
      const ts = transByEntity.get(e.entityId) ?? [];
      const stateSet = sortStrings(statesByEntity.get(e.entityId) ?? []);
      const hasOutgoing = new Set(ts.filter((t) => t.from !== null).map((t) => t.from as string));
      const transitions = [...ts]
        .sort((x, y) =>
          `${x.from ?? ""}\0${x.to}\0${x.trigger}` < `${y.from ?? ""}\0${y.to}\0${y.trigger}` ? -1 : 1,
        )
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

  return { lifecycles, entityCount: entities.length, transitionCount: transitions.length };
}

// ---------------------------------------------------------------------------
// Business rules and exceptions.
// ---------------------------------------------------------------------------

export interface RuleRecord {
  readonly id: string;
  /** A business-language statement of the rule. */
  readonly statement: string;
  readonly subject: string;
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

const RECOVERY_TRIGGERS: readonly string[] = ["withdraw", "cancel", "retry", "compensate", "recover", "rollback", "refund", "revert", "undo"];

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
    .filter((t) => RECOVERY_TRIGGERS.some((r) => t.trigger.toLowerCase().includes(r)))
    .sort((a, b) => (`${a.from ?? ""}\0${a.to}\0${a.trigger}` < `${b.from ?? ""}\0${b.to}\0${b.trigger}` ? -1 : 1))
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
  const printed = branches.total + lifecycle.transitionCount + rules.ruleCount + exceptions.total;
  const unresolved = lifecycle.lifecycles.reduce((n, l) => n + l.unresolvedOrigins, 0) + branches.counts.unknown;
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
 * Rules, states and exceptions must not contradict: a rule or transition that
 * names a state must name one the object's lifecycle actually has. A named state
 * absent from every lifecycle is a contradiction, not a silent omission.
 */
export function validateConsistency(rules: RuleSet, lifecycle: LifecycleSet): ContentValidation {
  const reasons: string[] = [];
  const allStates = new Set(lifecycle.lifecycles.flatMap((l) => l.states));
  for (const rule of rules.rules) {
    if (rule.stateName !== null && !allStates.has(rule.stateName)) {
      reasons.push(`rule ${rule.id} names state "${rule.stateName}" that no lifecycle has`);
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
  inputFactKinds: ["condition", "decision"],
  prompt: `Describe the module's business flows from the branches you are given — the happy path, the rejections and the conditional behaviour.\n\n${AUDIENCE_RULES}`,
};

export const MODULE_RULES_NOTES_BLOCK: AuthoredBlockContract = {
  blockId: "module-objects-rules-states.notes",
  outputSchemaId: "module-rules-notes.v1",
  promptId: "module-rules-notes.v1",
  citationRule: "required",
  validatorId: "module-rules-notes.v1",
  inputFactKinds: ["state-transition"],
  prompt: `Explain the object lifecycles, rules, states and exceptions you are given, keeping state names and messages verbatim.\n\n${AUDIENCE_RULES}`,
};

export const MODULE_RECOVERY_BLOCK: AuthoredBlockContract = {
  blockId: "module-recovery.notes",
  outputSchemaId: "module-recovery.v1",
  promptId: "module-recovery.v1",
  citationRule: "required",
  validatorId: "module-recovery.v1",
  inputFactKinds: ["state-transition", "condition"],
  prompt: `Describe the withdraw, cancel, retry, compensate and recover behaviours you are given. If none is evidenced, say the recovery behaviour is unknown.\n\n${AUDIENCE_RULES}`,
};

export const PM_FLOWS_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [
  MODULE_FLOWS_BLOCK,
  MODULE_RULES_NOTES_BLOCK,
  MODULE_RECOVERY_BLOCK,
];
