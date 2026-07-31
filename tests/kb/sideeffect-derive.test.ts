import { describe, expect, it } from "vitest";

import { declared, inferred, unresolved, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";
import type { DataAccessRecord, ExternalCallRecord, OutboundCallRecord } from "../../engine/structural/boundaries.js";
import type { NotificationCallRecord, TransactionBoundaryRecord } from "../../engine/structural/rules.js";
import {
  BEHAVIOR_SEMANTIC_KINDS,
  SIDE_EFFECT_KINDS,
  validateBehaviorModel,
  validateOwnership,
} from "../../engine/contracts/behavior/schema.js";
import { type SideEffectDeriveInput, deriveSideEffectBehavior } from "../../engine/kb/sideeffect-derive.js";

const sym = symbolId({ rootName: "svc", relPath: "a.go", kind: "function", qualifiedName: "Handler", signature: null });
const payloadOf = (f: { payload: unknown }) => f.payload as Record<string, unknown>;

function dataAccess(over: Partial<DataAccessRecord> = {}): DataAccessRecord {
  return { rootName: "svc", entity: "leaves", operation: "write", mechanism: "gorm", symbolId: sym, provenance: resolvedAt(10), ...over };
}
function transaction(over: Partial<TransactionBoundaryRecord> = {}): TransactionBoundaryRecord {
  return { rootName: "svc", symbolId: sym, mechanism: "db.Transaction", propagation: null, source: lineRef("svc", "a.go", 15), provenance: inferred(lineRef("svc", "a.go", 15), "low"), ...over };
}
function outbound(over: Partial<OutboundCallRecord> = {}): OutboundCallRecord {
  return { rootName: "svc", target: "/v2/leaves", kind: "http", method: "POST", callerSymbolId: sym, baseIdentifier: null, provenance: resolvedAt(20), ...over };
}
function external(over: Partial<ExternalCallRecord> = {}): ExternalCallRecord {
  return { rootName: "svc", callerSymbolId: sym, packageName: "stripe", memberName: "Charge", provenance: resolvedAt(25), ...over };
}
function notification(over: Partial<NotificationCallRecord> = {}): NotificationCallRecord {
  return { rootName: "svc", channel: "mail", mechanism: "sendMail", source: lineRef("svc", "a.go", 30), provenance: inferred(lineRef("svc", "a.go", 30), "low"), ...over };
}
function resolvedAt(line: number) {
  return declared(lineRef("svc", "a.go", line));
}

function derive(over: Partial<SideEffectDeriveInput> = {}) {
  return deriveSideEffectBehavior({
    dataAccess: over.dataAccess ?? [],
    transactions: over.transactions ?? [],
    outbound: over.outbound ?? [],
    external: over.external ?? [],
    notifications: over.notifications ?? [],
  });
}

describe("deriveSideEffectBehavior", () => {
  it("produces a contract-valid model across all side-effect kinds", () => {
    const model = derive({
      dataAccess: [dataAccess()],
      transactions: [transaction()],
      outbound: [outbound()],
      external: [external()],
      notifications: [notification()],
    });
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
    // external library call is unified under outbound-call, categorized apart
    expect(model.facts.map((f) => f.kind).sort()).toEqual([
      "data-access", "notification-call", "outbound-call", "outbound-call", "transaction-boundary",
    ]);
  });

  it("keeps PI-11 and PI-12 fact kinds disjoint — the ownership check accepts the partition", () => {
    expect(validateOwnership()).toEqual({ ok: true });
    const model = derive({ dataAccess: [dataAccess()], outbound: [outbound()], notifications: [notification()], transactions: [transaction()] });
    for (const fact of model.facts) {
      expect(SIDE_EFFECT_KINDS).toContain(fact.kind);
      expect(BEHAVIOR_SEMANTIC_KINDS).not.toContain(fact.kind);
    }
  });

  it("distinguishes DB read/write/unknown and marks a dynamic table unresolved", () => {
    const model = derive({
      dataAccess: [
        dataAccess({ operation: "read", entity: "users" }),
        dataAccess({ operation: "unknown", entity: null, provenance: unresolved(lineRef("svc", "a.go", 11), "dynamic table"), symbolId: null }),
      ],
    });
    const read = model.facts.find((f) => payloadOf(f).operation === "read")!;
    expect(read).toBeDefined();
    const dyn = model.facts.find((f) => payloadOf(f).operation === "unknown")!;
    expect(payloadOf(dyn).link).toBe("unresolved");
    expect(dyn.evidence[0]!.provenance.resolutionClass).toBe("unresolved");
  });

  it("marks a composed-base outbound call unresolved rather than inventing a target", () => {
    const model = derive({ outbound: [outbound({ target: null, baseIdentifier: "authApi" })] });
    const fact = model.facts[0]!;
    expect(payloadOf(fact).link).toBe("unresolved");
    expect(payloadOf(fact).baseIdentifier).toBe("authApi");
  });

  it("carries the outbound kind so a queue/message call is distinct from HTTP", () => {
    const model = derive({ outbound: [outbound({ kind: "http" }), outbound({ kind: "queue", target: "orders.created", method: null, provenance: resolvedAt(21) })] });
    expect(model.facts.map((f) => payloadOf(f).outboundKind).sort()).toEqual(["http", "queue"]);
  });

  it("unifies an external library call under outbound-call with an external-package category", () => {
    const model = derive({ external: [external()] });
    const fact = model.facts[0]!;
    expect(fact.kind).toBe("outbound-call");
    expect(payloadOf(fact).category).toBe("external-package");
    expect(payloadOf(fact).target).toBe("stripe.Charge");
  });

  it("carries the caller symbol so a later pass can connect the effect to its trigger", () => {
    const model = derive({ dataAccess: [dataAccess()], outbound: [outbound()] });
    for (const fact of model.facts) expect(payloadOf(fact).symbol).toBe(sym);
  });

  it("keeps a heuristic transaction/notification at its own (inferred) resolution", () => {
    const model = derive({ transactions: [transaction()], notifications: [notification()] });
    for (const fact of model.facts) expect(fact.evidence[0]!.provenance).toMatchObject({ resolutionClass: "inferred" });
  });

  it("dedupes an identical record rather than double-counting", () => {
    const d = dataAccess();
    const model = derive({ dataAccess: [d, d] });
    expect(model.facts).toHaveLength(1);
  });

  it("keeps two dynamic effects on the same line but different columns distinct", () => {
    const at = (col: number) => declared({ rootName: "svc", relPath: "a.go", startLine: 10, endLine: 10, startColumn: col, endColumn: null });
    const model = derive({
      dataAccess: [
        dataAccess({ entity: null, operation: "unknown", mechanism: "gorm", provenance: at(5) }),
        dataAccess({ entity: null, operation: "unknown", mechanism: "gorm", provenance: at(40) }),
      ],
    });
    expect(model.facts).toHaveLength(2);
  });

  it("returns an empty, valid model for no input", () => {
    const model = derive();
    expect(model.facts).toEqual([]);
    expect(validateBehaviorModel(model).ok).toBe(true);
  });
});
