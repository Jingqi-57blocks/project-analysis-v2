/**
 * Deriving authorization, validation and error-handling facts (PI-39).
 *
 * These come from the `conventions` enricher and the `logic` provider, which read
 * them heuristically — a middleware name, a validator call, a catch block. This is
 * the adapter that lifts those records into the shared behaviour contract (PI-62),
 * not a second scanner: it preserves each record's own resolution, so a heuristic
 * (inferred) fact never claims to be a resolved one and never overrides an
 * AST-resolvable fact.
 *
 * Three distinctions the derivation keeps rather than blurs:
 *   - authentication (are you someone) vs authorization (may you do this) — a
 *     requirement that names a permission is authorization; a bare mechanism is
 *     authentication; when neither is clear the check is left `unresolved` with
 *     its raw mechanism/requirement kept;
 *   - a visible rejection message (a guard's words, PI-37) vs an internal error
 *     type — this derives the internal types (error-handling.handles), never
 *     quoting a type as a user-facing message;
 *   - a catch-all (no named type) from a typed handler.
 */

import type { EvidenceRecord, ProviderAttribution } from "../contracts/shared-fact/evidence.js";
import { factId } from "../contracts/shared-fact/identity.js";
import type { Provenance } from "../contracts/shared-fact/provenance.js";
import {
  BEHAVIOR_SCHEMA_VERSION,
  type BehaviorFact,
  type BehaviorModel,
  type BehaviorPayload,
  type BehaviorScope,
} from "../contracts/behavior/schema.js";
import type { AuthAnnotationRecord } from "../structural/boundaries.js";
import type { ErrorHandlingRecord, ValidationRuleRecord, DiscardedErrorRecord } from "../structural/rules.js";

const CONVENTIONS: ProviderAttribution = { providerId: "conventions", providerVersion: "1.0.0" };
const LOGIC: ProviderAttribution = { providerId: "logic", providerVersion: "1.0.0" };

export interface BoundaryDeriveInput {
  readonly auth: readonly AuthAnnotationRecord[];
  readonly validations: readonly ValidationRuleRecord[];
  readonly errorHandling: readonly ErrorHandlingRecord[];
  readonly discarded: readonly DiscardedErrorRecord[];
}

export type AuthCheck = "authentication" | "authorization" | "unresolved";

function ev(attribution: ProviderAttribution, provenance: Provenance): EvidenceRecord {
  return { attribution, provenance };
}

function pl<T extends BehaviorPayload>(payload: T): BehaviorPayload {
  return payload;
}

function scopeOf(symbolId: string | null): BehaviorScope {
  return symbolId !== null ? "symbol" : "module";
}

/**
 * A requirement that names something to be held — a role, a permission, a scope —
 * is authorization; a bare authentication mechanism with nothing required is
 * authentication; anything else is left unresolved rather than guessed into one.
 * Uses generic access-control vocabulary only, never a project's own role names.
 */
const AUTHN_TOKENS: ReadonlySet<string> = new Set([
  "auth", "authn", "authenticate", "authenticated", "authentication",
  "login", "session", "token", "jwt", "identity", "principal", "user",
]);

function authCheckOf(mechanism: string, requirement: string | null): AuthCheck {
  if (requirement !== null && requirement.length > 0) return "authorization";
  const tokens = mechanism
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  if (tokens.some((token) => AUTHN_TOKENS.has(token))) return "authentication";
  return "unresolved";
}

function authFact(a: AuthAnnotationRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "auth-annotation",
      discriminators: [a.rootName, a.source.relPath, String(a.source.startLine), a.mechanism, a.requirement ?? ""],
    }),
    family: "behavioral",
    kind: "auth-annotation",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(CONVENTIONS, a.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(a.symbolId),
      activation: "guarded",
      check: authCheckOf(a.mechanism, a.requirement),
      mechanism: a.mechanism,
      requirement: a.requirement,
    }),
  };
}

function validationFact(v: ValidationRuleRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "validation-rule",
      discriminators: [v.rootName, v.source.relPath, String(v.source.startLine), v.field ?? "", v.rule, v.expression ?? ""],
    }),
    family: "behavioral",
    kind: "validation-rule",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(CONVENTIONS, v.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(v.subjectSymbolId),
      activation: "guarded",
      field: v.field,
      rule: v.rule,
      expression: v.expression,
    }),
  };
}

function errorHandlingFact(e: ErrorHandlingRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "error-handling",
      // Spread the sorted handles as their own discriminators (joinKey escapes each
      // separately), so ["A","B"] and ["A,B"] cannot collide through a "," join.
      discriminators: [e.rootName, e.source.relPath, String(e.source.startLine), e.scope, ...[...e.handles].sort()],
    }),
    family: "behavioral",
    kind: "error-handling",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(CONVENTIONS, e.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(e.symbolId),
      activation: "conditional",
      // The internal error types this handles — never a user-facing message. Sorted
      // so the persisted payload is byte-stable however the record ordered them
      // (handles are a set of types, not an ordered sequence).
      handles: [...e.handles].sort(),
      catchAll: e.handles.length === 0,
      errorScope: e.scope,
    }),
  };
}

function discardedFact(d: DiscardedErrorRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "discarded-error",
      discriminators: [d.rootName, d.source.relPath, String(d.source.startLine), d.call, d.mechanism],
    }),
    family: "behavioral",
    kind: "discarded-error",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(LOGIC, d.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(d.enclosingFunction),
      activation: "always",
      call: d.call,
      mechanism: d.mechanism,
    }),
  };
}

/**
 * Derive the authorization/validation/error-handling slice of the behaviour model.
 * Each fact keeps its source record's resolution and confidence — a heuristic stays
 * heuristic — and two records that describe the same fact are deduped by canonical
 * id rather than double-counted.
 */
export function deriveBoundaryBehavior(input: BoundaryDeriveInput): BehaviorModel {
  const facts: BehaviorFact[] = [];
  const seen = new Set<string>();
  const add = (fact: BehaviorFact): void => {
    if (seen.has(fact.factId)) return;
    seen.add(fact.factId);
    facts.push(fact);
  };

  for (const a of input.auth) add(authFact(a));
  for (const v of input.validations) add(validationFact(v));
  for (const e of input.errorHandling) add(errorHandlingFact(e));
  for (const d of input.discarded) add(discardedFact(d));

  return { schemaVersion: BEHAVIOR_SCHEMA_VERSION, facts, relations: [] };
}
