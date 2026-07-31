/**
 * The Provider/Reader migration matrix.
 *
 * Fixes the destination of every existing analysis unit before the CodeGraph and
 * behaviour work begins, so a later agent extends the existing emitter instead
 * of writing a parallel one. The authoritative migration intent is the Linear
 * "Provider / Reader 迁移合同"; this is its versioned, machine-checkable form,
 * grounded in the actual code.
 */

/** Where an existing unit goes. Exactly one per unit. */
export type MigrationHome = "retain" | "adapt" | "enricher" | "test-only" | "net-new" | "remove";

/** How a downstream issue treats it. */
export type MigrationAction = "extend" | "adapt" | "integrate" | "replace" | "net-new";

/** The fixed vocabulary. Reader is no longer a top-level abstraction. */
export type UnitRole = "provider" | "deriver" | "enricher" | "collector" | "parser" | "test-provider";

export const TERMINOLOGY: { readonly [K in UnitRole]: string } = {
  provider: "top-level evidence source; declares capability/gap/failure and provenance",
  deriver: "consumes standardized facts to produce higher-level ones; never bypasses canonical identity",
  enricher: "optional language/framework-local enhancement; never decides whether an unfamiliar project works",
  collector: "gathers citable evidence only; draws no conclusion",
  parser: "a provider-internal local parsing implementation; not a top-level abstraction",
  "test-provider": "fixture/contract-test only; never in the production default path",
};

export interface ProviderUnit {
  readonly id: string;
  readonly files: readonly string[];
  readonly role: UnitRole;
  /** The fact/record kinds it emits. */
  readonly factKinds: readonly string[];
  /** True if wired into the default analysis path (defaultReaders). */
  readonly registered: boolean;
  readonly consumers: readonly string[];
  readonly hasTests: boolean;
  readonly home: MigrationHome;
  readonly action: MigrationAction;
  /** The downstream issues that own its migration (PI-5, PI-11, ...). */
  readonly targetIssues: readonly string[];
  /** The parallel implementation this forbids. */
  readonly forbiddenParallel: string;
  /** Required for a `remove`/`replace` home: consumers zero + parity + rollback. */
  readonly removalCondition?: string;
  readonly note?: string;
}

export interface MigrationMatrix {
  readonly version: string;
  readonly units: readonly ProviderUnit[];
}

/**
 * The M2 behaviour/side-effect fact kinds the matrix must account for — each is
 * emitted by some existing unit or introduced net-new; none may be silently
 * missing when M2 begins.
 */
export const M2_FACT_KINDS: readonly string[] = [
  "condition",
  "decision",
  "guard",
  "discarded-error",
  "value-set",
  "business-rule",
  "validation-rule",
  "transaction-boundary",
  "error-handling",
  "auth-annotation",
  "notification-call",
  "outbound-call",
  "data-access",
  "test-relation",
  "state",
  "transition",
];

export type MatrixValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

export function validateMatrix(matrix: MigrationMatrix): MatrixValidation {
  const reasons: string[] = [];
  const ids = new Set<string>();
  const HOMES: readonly MigrationHome[] = ["retain", "adapt", "enricher", "test-only", "net-new", "remove"];

  for (const unit of matrix.units) {
    if (ids.has(unit.id)) reasons.push(`duplicate unit id: ${unit.id}`);
    ids.add(unit.id);
    if (!HOMES.includes(unit.home)) reasons.push(`${unit.id}: unknown home ${unit.home}`);
    if (unit.home !== "net-new" && unit.files.length === 0) reasons.push(`${unit.id}: no files`);
    if (unit.forbiddenParallel.length === 0) reasons.push(`${unit.id}: must name the forbidden parallel implementation`);
    if ((unit.home === "remove" || unit.action === "replace") && !unit.removalCondition) {
      reasons.push(`${unit.id}: a remove/replace home needs a removalCondition`);
    }
  }

  // Every M2 fact kind is emitted by some unit or introduced net-new.
  for (const kind of M2_FACT_KINDS) {
    const covered = matrix.units.some((u) => u.factKinds.includes(kind));
    if (!covered) reasons.push(`M2 fact kind ${kind} maps to no unit and is not net-new`);
  }

  // state/transition must be net-new (no existing emitter).
  for (const kind of ["state", "transition"]) {
    const emitters = matrix.units.filter((u) => u.factKinds.includes(kind));
    if (!emitters.some((u) => u.home === "net-new")) {
      reasons.push(`${kind} must be introduced by a net-new unit`);
    }
  }

  // test-relation exists but must be explicitly homed (integrate/replace/adapt), not silently left.
  const testUnit = matrix.units.find((u) => u.factKinds.includes("test-relation"));
  if (!testUnit) reasons.push("no unit accounts for test-relation");
  else if (testUnit.registered) {
    reasons.push("test-relation unit is marked registered; the contract says it exists but is unregistered");
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
