/**
 * Associating tests with the behaviour they exercise (PI-40).
 *
 * The `engine/providers/tests` provider already reads test relations from the
 * assembled model — test files by convention, targets from the call edges the
 * model holds. This is the adapter that lifts its `TestRelationRecord`s into the
 * shared behaviour contract (PI-62), reusing that provider's output rather than
 * standing up a second test-relation reader.
 *
 * Two things it keeps honest. A relation to a resolved target is different from
 * one whose target could only be named — the resolution the provider recorded is
 * preserved, so a report can say which behaviour has *resolved* test evidence
 * without claiming the code is correct. And "the project has no test relations"
 * is a different fact from "the test-relation reader did not run": the caller
 * passes an execution receipt (`providerRan`), and the result reports `not-run`
 * rather than an empty set the reader never populated.
 *
 * A fact carries the test symbol and its target so a later pass can connect a
 * test to the entry, rule, state or side-effect fact it exercises — by shared
 * symbol identity, not a relation invented across slices here.
 */

import type { EvidenceRecord, ProviderAttribution } from "../contracts/shared-fact/evidence.js";
import { factId } from "../contracts/shared-fact/identity.js";
import {
  BEHAVIOR_SCHEMA_VERSION,
  type BehaviorFact,
  type BehaviorModel,
  type BehaviorPayload,
} from "../contracts/behavior/schema.js";
import type { TestRelationRecord } from "../structural/boundaries.js";

const TESTS: ProviderAttribution = { providerId: "test-relations", providerVersion: "1.0.0" };

export interface TestBehaviorInput {
  readonly testRelations: readonly TestRelationRecord[];
  /** The execution receipt: did the test-relation reader run for this snapshot? */
  readonly providerRan: boolean;
}

/** covered = the reader ran (its result set, empty or not, is authoritative). */
export type TestCoverage = "covered" | "not-run";

export interface TestBehaviorResult {
  readonly model: BehaviorModel;
  readonly coverage: TestCoverage;
}

function pl<T extends BehaviorPayload>(payload: T): BehaviorPayload {
  return payload;
}

function ev(provenance: TestRelationRecord["provenance"]): EvidenceRecord {
  return { attribution: TESTS, provenance };
}

function testFact(r: TestRelationRecord): BehaviorFact {
  // Tag the target's kind so a resolved symbol id can never collide with a
  // named-only target that happens to be the same string — the two live in
  // different value spaces and stay distinct facts.
  const target = r.targetSymbolId !== null ? r.targetSymbolId : (r.targetName ?? "");
  const targetKind = r.targetSymbolId !== null ? "sym" : "name";
  return {
    factId: factId({
      family: "behavioral",
      kind: "test-relation",
      discriminators: [r.rootName, r.testSymbolId, targetKind, target, r.relation],
    }),
    family: "behavioral",
    kind: "test-relation",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(r.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: "symbol",
      activation: "always",
      testSymbol: r.testSymbolId,
      targetSymbol: r.targetSymbolId,
      targetName: r.targetName,
      relation: r.relation,
      // resolved when the reader tied the test to a symbol; a named-only or empty
      // target is a real unresolved finding, kept (its provenance says so).
      link: r.targetSymbolId !== null ? "resolved" : "unresolved",
    }),
  };
}

/**
 * Derive the test-relation slice of the behaviour model. Each record becomes one
 * fact keyed by canonical id (so a re-read does not double-count); the `coverage`
 * distinguishes an empty result the reader produced from one it never ran.
 */
export function deriveTestBehavior(input: TestBehaviorInput): TestBehaviorResult {
  const facts: BehaviorFact[] = [];
  const seen = new Set<string>();
  for (const record of input.testRelations) {
    const fact = testFact(record);
    if (seen.has(fact.factId)) continue;
    seen.add(fact.factId);
    facts.push(fact);
  }
  return {
    model: { schemaVersion: BEHAVIOR_SCHEMA_VERSION, facts, relations: [] },
    coverage: input.providerRan ? "covered" : "not-run",
  };
}
