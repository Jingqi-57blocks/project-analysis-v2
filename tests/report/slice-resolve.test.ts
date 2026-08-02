import { describe, expect, it } from "vitest";

import { moduleScope } from "../../engine/contracts/report/target.js";
import {
  coverageInputForKind,
  createSliceReaders,
  readerClassOf,
  resolveKindCoverage,
  resolveSliceFacts,
} from "../../engine/report/slice-resolve.js";
import { classifyCoverage } from "../../engine/contracts/shared-fact/applicability.js";
import { SNAPSHOT_ID, insertBehaviorFact, insertStructuralRecord, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";

const IN_MODULE = ["handlers/leave/notification.go", "handlers/leave/service.go"];
const OUT_OF_MODULE = "handlers/payroll/service.go";

/** A KB with 8 in-module notification facts, 2 out-of-module, plus a few others. */
function seedNotificationKb() {
  const store = seedStore();
  for (let i = 0; i < 8; i += 1) {
    insertBehaviorFact(store, {
      factId: `behavioral|notification-call|r1|handlers/leave/notification.go:${100 + i}|n${i}`,
      kind: "notification-call",
      relPath: "handlers/leave/notification.go",
      startLine: 100 + i,
      resolutionClass: "inferred",
      payload: { scope: "module", activation: "always", channel: "mail", mechanism: `send-${i}` },
    });
  }
  // Two notification facts outside the module — must be filtered out.
  for (let i = 0; i < 2; i += 1) {
    insertBehaviorFact(store, {
      factId: `behavioral|notification-call|r1|handlers/payroll/service.go:${200 + i}|p${i}`,
      kind: "notification-call",
      relPath: OUT_OF_MODULE,
      startLine: 200 + i,
    });
  }
  return store;
}

describe("resolveSliceFacts — behaviour kinds via the behaviour query, scoped by membership", () => {
  it("resolves the 8 populated in-module notification facts, cited and sorted, and drops the out-of-module ones", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const facts = resolveSliceFacts(readers, moduleScope("leave"), ["notification-call"]);

    expect(facts).toHaveLength(8);
    expect(facts.every((f) => f.kind === "notification-call")).toBe(true);
    expect(facts.every((f) => f.citation.relPath === "handlers/leave/notification.go")).toBe(true);
    // Every cited fact carries an id, a verbatim value and a resolution class.
    const first = facts[0]!;
    expect(first.factId).toContain("notification-call");
    expect(first.resolutionClass).toBe("inferred");
    expect(first.value).toMatchObject({ mechanism: expect.any(String) });
    // Stable order — sorted by fact id.
    const ids = facts.map((f) => f.factId);
    expect(ids).toEqual([...ids].sort());
  });

  it("maps the catalog `state-transition` kind onto the behaviour model's `transition` facts", () => {
    const store = seedStore();
    insertBehaviorFact(store, { factId: "behavioral|transition|r1|handlers/leave/service.go:10|t1", kind: "transition", relPath: "handlers/leave/service.go", startLine: 10 });
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const facts = resolveSliceFacts(readers, moduleScope("leave"), ["state-transition"]);
    expect(facts).toHaveLength(1);
    // The cited fact keeps the slice's declared kind, so it stays inside the slice.
    expect(facts[0]!.kind).toBe("state-transition");
  });

  it("resolves a structural kind from the structural records, scoped by rel path", () => {
    const store = seedStore();
    insertStructuralRecord(store, { recordKey: "r1|handlers/leave/service.go|func|Apply", kind: "symbol", relPath: "handlers/leave/service.go", startLine: 5 });
    insertStructuralRecord(store, { recordKey: "r1|handlers/payroll/service.go|func|Pay", kind: "symbol", relPath: OUT_OF_MODULE, startLine: 5 });
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const facts = resolveSliceFacts(readers, moduleScope("leave"), ["symbol"]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.factId).toContain("handlers/leave/service.go");
    expect(facts[0]!.citation.startLine).toBe(5);
  });

  it("returns an empty slice for a kind with no facts in the module, never a fabricated one", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(resolveSliceFacts(readers, moduleScope("leave"), ["outbound-call"])).toEqual([]);
  });

  it("resolves nothing for a scope that is not this membership's module", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(resolveSliceFacts(readers, moduleScope("payroll"), ["notification-call"])).toEqual([]);
  });

  it("is deterministic — two resolutions of one frozen KB are identical", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const a = resolveSliceFacts(readers, moduleScope("leave"), ["notification-call"]);
    const b = resolveSliceFacts(readers, moduleScope("leave"), ["notification-call"]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("coverageInputForKind — honest per-kind coverage for the applicability compiler", () => {
  it("a behaviour kind with facts is found, and with none is not-found", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const found = coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "notification-call"));
    const empty = coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "outbound-call"));
    expect(classifyCoverage(found).state).toBe("found");
    expect(classifyCoverage(empty).state).toBe("not-found");
  });

  it("a kind this resolver cannot read is unknown, never a confirmed absence", () => {
    const store = seedStore();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(readerClassOf("call-edge")).toBe("none");
    expect(classifyCoverage(coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "call-edge"))).state).toBe("unknown");
  });

  it("a module with no attributed diagnostics is unknown, not not-found", () => {
    const store = seedStore();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(classifyCoverage(coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "diagnostic"))).state).toBe("unknown");
  });

  it("identity, coverage and the `*` ledger are always found — rendered from the run, not a KB slice", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    for (const kind of ["run-identity", "coverage", "*"]) {
      expect(classifyCoverage(coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), kind))).state).toBe("found");
    }
  });
});
