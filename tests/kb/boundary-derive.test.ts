import { describe, expect, it } from "vitest";

import { declared, inferred, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";
import type { AuthAnnotationRecord } from "../../engine/structural/boundaries.js";
import type { DiscardedErrorRecord, ErrorHandlingRecord, ValidationRuleRecord } from "../../engine/structural/rules.js";
import { validateBehaviorModel } from "../../engine/contracts/behavior/schema.js";
import { type BoundaryDeriveInput, deriveBoundaryBehavior } from "../../engine/kb/boundary-derive.js";

const sym = symbolId({ rootName: "svc", relPath: "a.go", kind: "function", qualifiedName: "Handler", signature: null });

function auth(mechanism: string, requirement: string | null): AuthAnnotationRecord {
  return {
    rootName: "svc",
    symbolId: sym,
    mechanism,
    requirement,
    source: lineRef("svc", "a.go", 5),
    provenance: inferred(lineRef("svc", "a.go", 5), "low"),
  };
}

function validation(field: string | null, rule: string, expression: string | null): ValidationRuleRecord {
  return {
    rootName: "svc",
    subjectSymbolId: sym,
    field,
    rule,
    expression,
    source: lineRef("svc", "a.go", 10),
    provenance: inferred(lineRef("svc", "a.go", 10), "medium"),
  };
}

function errorHandling(handles: readonly string[], scope: ErrorHandlingRecord["scope"] = "function"): ErrorHandlingRecord {
  return {
    rootName: "svc",
    symbolId: sym,
    handles,
    scope,
    source: lineRef("svc", "a.go", 20),
    provenance: declared(lineRef("svc", "a.go", 20)),
  };
}

function discarded(call: string): DiscardedErrorRecord {
  return {
    rootName: "svc",
    call,
    mechanism: "goroutine",
    enclosingFunction: "Handler",
    source: lineRef("svc", "a.go", 30),
    provenance: declared(lineRef("svc", "a.go", 30)),
  };
}

function derive(over: Partial<BoundaryDeriveInput> = {}) {
  return deriveBoundaryBehavior({
    auth: over.auth ?? [],
    validations: over.validations ?? [],
    errorHandling: over.errorHandling ?? [],
    discarded: over.discarded ?? [],
  });
}

const payloadOf = (f: { payload: unknown }) => f.payload as Record<string, unknown>;

describe("deriveBoundaryBehavior", () => {
  it("produces a contract-valid model", () => {
    const model = derive({
      auth: [auth("requireRole", "admin")],
      validations: [validation("email", "format", "isEmail(email)")],
      errorHandling: [errorHandling(["NotFoundError"])],
      discarded: [discarded("go notify()")],
    });
    expect(validateBehaviorModel(model)).toEqual({ ok: true, quarantined: [] });
    expect(model.facts.map((f) => f.kind).sort()).toEqual(["auth-annotation", "discarded-error", "error-handling", "validation-rule"]);
  });

  it("distinguishes authorization from authentication, and leaves the unclear unresolved", () => {
    const model = derive({
      auth: [auth("requirePermission", "orders:write"), auth("requireLogin", null), auth("customMiddleware", null)],
    });
    const checks = model.facts.map((f) => payloadOf(f).check);
    expect(checks).toContain("authorization"); // requirement named
    expect(checks).toContain("authentication"); // bare login mechanism
    expect(checks).toContain("unresolved"); // neither clear
  });

  it("records internal error types on a typed handler and marks a catch-all", () => {
    const model = derive({ errorHandling: [errorHandling(["ValidationError", "NotFoundError"]), errorHandling([])] });
    const typed = model.facts.find((f) => (payloadOf(f).handles as string[]).length > 0)!;
    expect(payloadOf(typed).handles).toEqual(["NotFoundError", "ValidationError"]); // sorted, stable
    expect(payloadOf(typed).catchAll).toBe(false);
    const catchAll = model.facts.find((f) => payloadOf(f).catchAll === true)!;
    expect(catchAll).toBeDefined();
  });

  it("does not collapse two handlers whose sorted handles could join to the same string", () => {
    const model = derive({
      errorHandling: [
        { ...errorHandling(["A", "B"]), source: lineRef("svc", "a.go", 20) },
        { ...errorHandling(["A,B"]), source: lineRef("svc", "a.go", 20) },
      ],
    });
    expect(model.facts.filter((f) => f.kind === "error-handling")).toHaveLength(2);
    expect(validateBehaviorModel(model).ok).toBe(true);
  });

  it("keeps a heuristic record's own (inferred) resolution — it does not upgrade to resolved", () => {
    const model = derive({ auth: [auth("requireRole", "admin")] });
    expect(model.facts[0]!.evidence[0]!.provenance).toMatchObject({ resolutionClass: "inferred", confidence: "low" });
  });

  it("dedupes two identical records rather than double-counting", () => {
    const a = auth("requireRole", "admin");
    const model = derive({ auth: [a, a] });
    expect(model.facts.filter((f) => f.kind === "auth-annotation")).toHaveLength(1);
  });

  it("carries validation field, rule and expression", () => {
    const model = derive({ validations: [validation("age", "min", "age >= 18")] });
    const fact = model.facts.find((f) => f.kind === "validation-rule")!;
    expect(payloadOf(fact)).toMatchObject({ field: "age", rule: "min", expression: "age >= 18", activation: "guarded" });
  });

  it("returns an empty, valid model for no input", () => {
    const model = derive();
    expect(model.facts).toEqual([]);
    expect(validateBehaviorModel(model).ok).toBe(true);
  });
});
