import { describe, expect, it } from "vitest";

import { behaviorInputFrom } from "../../engine/kb/behavior-input.js";
import type { RootFacts } from "../../engine/kb/extract.js";
import type { AssembledRecord } from "../../engine/structural/assemble.js";
import type { CallEdgeRecord, SymbolRecord } from "../../engine/structural/code.js";
import { declared, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";

const ROOT = "svc";

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

    // No index passed and no roots — reachability adds nothing and says so.
    expect(notes).toEqual(["notification-reachability: no code index available — no reverse-reachability attributed"]);
    expect(input.decisions.conditions).toEqual([]);
    expect(input.decisions.decisions).toEqual([]);
    expect(input.decisions.guards).toEqual([]);
    expect(input.decisions.rules).toEqual([]);
    expect(input.boundary.auth).toEqual([]);
    expect(input.sideEffects.notifications).toEqual([]); // wired to g.notifications

    // external calls (no provider) stay empty — disclosed, not a whitelist
    expect(input.sideEffects.external).toEqual([]);
    // state changes are now observed generically (empty here only because there are no roots)
    expect(input.states.changes).toEqual([]);

    // PI-84: the test-relation reader is now wired and part of every run. With no
    // roots there are no relations, but the reader ran — providerRan is true, no
    // longer the false it disclosed while the family was unlinked.
    expect(input.tests.testRelations).toEqual([]);
    expect(input.tests.providerRan).toBe(true);
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

  it("discloses a degraded index (a root with no indexed symbols) rather than passing it off as no tests", () => {
    // A root that produced zero symbols cannot confirm test coverage; the reader
    // still ran (providerRan stays true) but the absence is noted, not silent.
    const root = rootWith([], ["user.go"]);
    const { input, notes } = behaviorInputFrom([root]);
    expect(input.tests.providerRan).toBe(true);
    expect(input.tests.testRelations).toEqual([]);
    expect(notes).toContain("test-relations: 0 symbols in svc — coverage cannot be confirmed");
  });
});
