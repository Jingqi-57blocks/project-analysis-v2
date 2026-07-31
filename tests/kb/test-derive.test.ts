import { describe, expect, it } from "vitest";

import { resolved, unresolved, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";
import type { TestRelationRecord, TestRelation } from "../../engine/structural/boundaries.js";
import { validateBehaviorModel } from "../../engine/contracts/behavior/schema.js";
import { deriveTestBehavior } from "../../engine/kb/test-derive.js";

const testSym = symbolId({ rootName: "svc", relPath: "a_test.go", kind: "function", qualifiedName: "TestApprove", signature: null });
const targetSym = symbolId({ rootName: "svc", relPath: "a.go", kind: "function", qualifiedName: "Approve", signature: null });

function rel(over: Partial<TestRelationRecord> = {}): TestRelationRecord {
  return {
    rootName: "svc",
    testSymbolId: testSym,
    targetSymbolId: targetSym,
    targetName: "Approve",
    relation: "covers",
    provenance: resolved(lineRef("svc", "a_test.go", 5), "high"),
    ...over,
  };
}

const payloadOf = (f: { payload: unknown }) => f.payload as Record<string, unknown>;

describe("deriveTestBehavior", () => {
  it("produces a contract-valid model from resolved relations", () => {
    const { model, coverage } = deriveTestBehavior({ testRelations: [rel()], providerRan: true });
    expect(coverage).toBe("covered");
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
    const fact = model.facts[0]!;
    expect(fact.kind).toBe("test-relation");
    expect(payloadOf(fact).link).toBe("resolved");
    expect(payloadOf(fact).relation).toBe("covers");
  });

  it("carries the test symbol and its target so a later pass can connect them", () => {
    const { model } = deriveTestBehavior({ testRelations: [rel()], providerRan: true });
    expect(payloadOf(model.facts[0]!).testSymbol).toBe(testSym);
    expect(payloadOf(model.facts[0]!).targetSymbol).toBe(targetSym);
  });

  it("keeps an unresolved target as a real finding, not a drop", () => {
    const r = rel({ targetSymbolId: null, targetName: "MaybeApprove", provenance: unresolved(lineRef("svc", "a_test.go", 9), "dynamic target") });
    const { model } = deriveTestBehavior({ testRelations: [r], providerRan: true });
    const fact = model.facts[0]!;
    expect(payloadOf(fact).link).toBe("unresolved");
    expect(payloadOf(fact).targetName).toBe("MaybeApprove");
    expect(fact.evidence[0]!.provenance.resolutionClass).toBe("unresolved");
  });

  it("preserves the relation kind (covers / references / unknown)", () => {
    const kinds: TestRelation[] = ["covers", "references", "unknown"];
    const { model } = deriveTestBehavior({
      testRelations: kinds.map((relation, i) => rel({ relation, targetName: `T${i}`, targetSymbolId: null, provenance: unresolved(lineRef("svc", "a_test.go", 10 + i), "x") })),
      providerRan: true,
    });
    expect(model.facts.map((f) => payloadOf(f).relation).sort()).toEqual(["covers", "references", "unknown"]);
  });

  it("distinguishes no-test-relations (reader ran) from reader-did-not-run", () => {
    const covered = deriveTestBehavior({ testRelations: [], providerRan: true });
    expect(covered.coverage).toBe("covered");
    expect(covered.model.facts).toHaveLength(0);

    const notRun = deriveTestBehavior({ testRelations: [], providerRan: false });
    expect(notRun.coverage).toBe("not-run");
  });

  it("dedupes an identical relation rather than double-counting", () => {
    const r = rel();
    const { model } = deriveTestBehavior({ testRelations: [r, r], providerRan: true });
    expect(model.facts).toHaveLength(1);
  });
});
