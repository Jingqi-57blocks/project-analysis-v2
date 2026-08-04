import { describe, expect, it } from "vitest";

import { behaviorInputFrom } from "../../engine/kb/behavior-input.js";
import type { RootFacts } from "../../engine/kb/extract.js";
import type { AssembledRecord } from "../../engine/structural/assemble.js";
import type { CallEdgeRecord, SymbolRecord } from "../../engine/structural/code.js";
import { declared, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";
import { gradeBehaviorTruth } from "../support/gates/behavior-truth.js";
import type { BehaviorModel } from "../../engine/contracts/behavior/schema.js";
import type { TruthItem } from "../../engine/contracts/truth/schema.js";
import type { TestCoverage } from "../../engine/kb/test-derive.js";

const ROOT = "svc";

const emptyModel = (): BehaviorModel => ({ schemaVersion: "1.0.0", facts: [], relations: [] });

function truthItem(over: Partial<TruthItem>): TruthItem {
  return {
    id: "T-X",
    facets: ["M2"],
    category: "test-relation",
    claim: "c",
    evidence: [{ root: ROOT, path: "internal/handlers/leave/", lines: "1" }],
    expectedResolution: "observed",
    expectedStatus: "absent",
    criticality: "normal",
    mustFind: true,
    mustPrint: true,
    requiredScope: ["module"],
    requiredAudience: ["developer"],
    ...over,
  };
}

function symbolRecord(name: string, relPath: string): SymbolRecord {
  return {
    id: symbolId({ rootName: ROOT, relPath, kind: "function", qualifiedName: name, signature: null }),
    name,
    qualifiedName: name,
    kind: "function",
    visibility: "unknown",
    signature: null,
    containerId: null,
    provenance: declared(lineRef(ROOT, relPath, 10, 20)),
  };
}

function record(kind: "symbol" | "call-edge", key: string, value: unknown): AssembledRecord {
  return { kind, key, record: value, attributions: [], conflicts: [], precedenceReason: null };
}

/** A minimal RootFacts carrying only the structural records the bridge reads. */
function rootWith(records: AssembledRecord[], analyzedFiles: string[]): RootFacts {
  return {
    rootName: ROOT,
    model: { rootName: ROOT, records, gaps: [], failures: [] },
    contributions: [],
    evidence: { rootName: ROOT, items: [], gaps: [], failures: [] },
    valueSets: [],
    vocabularyFailures: [],
    summary: { name: ROOT, language: null, analyzed: analyzedFiles.length, excluded: 0 },
    analyzedFiles,
    generatedFiles: new Set(),
  };
}

describe("behaviorInputFrom — the bridge from extracted evidence to the behaviour derivers", () => {
  it("produces the full five-part input shape, with the not-yet-extracted families disclosed empty", () => {
    // Over no roots the bridge still returns the full five-part shape, so a real run
    // always has a complete input. Conditions, decisions, guards, rules, value sets,
    // auth, validations, error handling, data access, transactions, outbound and
    // notification calls are all wired (empty here only because there are no roots).
    const { input, notes } = behaviorInputFrom([]);

    // No index passed and no roots — both reachability passes add nothing and say so.
    expect(notes).toEqual([
      "notification-reachability: no code index available — no reverse-reachability attributed",
      "outbound-integration: no code index available — no reverse-reachability attributed",
      "outbound-integration: 0 direct sink(s), 0 reached record(s)",
    ]);
    expect(input.decisions.conditions).toEqual([]);
    expect(input.decisions.decisions).toEqual([]);
    expect(input.decisions.guards).toEqual([]);
    expect(input.decisions.rules).toEqual([]);
    expect(input.boundary.auth).toEqual([]);
    expect(input.sideEffects.notifications).toEqual([]); // wired to g.notifications

    // external library outbound sinks come from the generic observer (empty here
    // only because there are no roots to scan) — disclosed, not a whitelist
    expect(input.sideEffects.external).toEqual([]);
    // state changes are now observed generically (empty here only because there are no roots)
    expect(input.states.changes).toEqual([]);

    // PI-84: the test-relation reader is wired, but coverage is only confirmable
    // over a populated index. With no analyzed roots the reader ran over nothing,
    // so providerRan is false — the gate must not certify a test-absence off an
    // index it never really read.
    expect(input.tests.testRelations).toEqual([]);
    expect(input.tests.providerRan).toBe(false);
  });

  it("derives test relations from a root's symbols and call edges (PI-84)", () => {
    const test = symbolRecord("TestCreate", "user_test.go");
    const prod = symbolRecord("Create", "user.go");
    const edge: CallEdgeRecord = {
      callerId: test.id,
      calleeId: prod.id,
      calleeName: "Create",
      provenance: declared(lineRef(ROOT, "user_test.go", 12)),
    };
    const root = rootWith(
      [
        record("symbol", "s|test", test),
        record("symbol", "s|prod", prod),
        record("call-edge", "e|test>prod", edge),
      ],
      ["user_test.go", "user.go"],
    );

    const { input } = behaviorInputFrom([root]);
    expect(input.tests.providerRan).toBe(true);
    expect(input.tests.testRelations.length).toBe(1);
    expect(input.tests.testRelations[0]).toMatchObject({ targetName: "Create", relation: "covers" });
  });

  it("withholds the coverage receipt for a degraded index (a root with no indexed symbols)", () => {
    // A root that produced zero symbols is a degraded/stale/missing index: the
    // reader saw nothing, so it cannot attest a test is absent. providerRan is
    // false (coverage "not-run") and the absence is disclosed, not silent — the
    // gate then fails closed rather than certifying a false absence.
    const root = rootWith([], ["user.go"]);
    const { input, notes } = behaviorInputFrom([root]);
    expect(input.tests.providerRan).toBe(false);
    expect(input.tests.testRelations).toEqual([]);
    expect(notes).toContain("test-relations: 0 symbols in svc — coverage cannot be confirmed");
  });

  it("a degraded index flows through to the gate withholding a test-relation absence (P0)", () => {
    // The end-to-end consequence: a 0-symbol root yields providerRan false, which
    // deriveTestBehavior turns into coverage "not-run", which the gate reads to
    // withhold a test-relation absence — not-found, never a false "honestly absent".
    const degraded = rootWith([], ["user.go"]);
    const { input } = behaviorInputFrom([degraded]);
    const coverage: TestCoverage = input.tests.providerRan ? "covered" : "not-run";
    expect(coverage).toBe("not-run");

    const absence = truthItem({
      category: "test-relation",
      expectedStatus: "absent",
      evidence: [{ root: ROOT, path: "internal/handlers/leave/", lines: "1" }],
    });
    const report = gradeBehaviorTruth([absence], emptyModel(), ROOT, coverage);
    expect(report.results[0]!.status).toBe("not-found");
    expect(report.results[0]!.detail).toContain("reader not-run");
  });
});
