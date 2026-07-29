import { describe, expect, it } from "vitest";

import { recordKey } from "../../engine/structural/recordkey.js";
import { inferred, lineRef } from "../../engine/structural/provenance.js";

/**
 * These kinds are supplied today by providers that leave every symbol id null,
 * so their keys have to carry the full location. A key missing `relPath`
 * collapses to a label, and unrelated facts across the repository merge into
 * one record — invisibly, because a merge records an extra attribution rather
 * than a conflict.
 */

function validationRule(relPath: string, line: number, expression: string) {
  return {
    rootName: "svc",
    subjectSymbolId: null,
    field: null,
    rule: "binding",
    expression,
    source: lineRef("svc", relPath, line),
    provenance: inferred(lineRef("svc", relPath, line), "high"),
  };
}

function errorHandling(relPath: string, line: number) {
  return {
    rootName: "svc",
    symbolId: null,
    handles: [],
    scope: "call-site",
    source: lineRef("svc", relPath, line),
    provenance: inferred(lineRef("svc", relPath, line), "high"),
  };
}

describe("keys for symbol-less kinds", () => {
  it("keeps two validation rules in different files apart", () => {
    const a = recordKey("validation-rule", validationRule("user.go", 5, "required,email"));
    const b = recordKey("validation-rule", validationRule("order.go", 999, "min=8"));
    expect(a).not.toBe(b);
  });

  it("keeps two validation rules on different lines of one file apart", () => {
    expect(recordKey("validation-rule", validationRule("user.go", 5, "required"))).not.toBe(
      recordKey("validation-rule", validationRule("user.go", 9, "required")),
    );
  });

  it("keeps error handling at the same line number in different files apart", () => {
    // Extremely likely in any real codebase: two files whose `if err != nil {`
    // happen to land on the same line.
    expect(recordKey("error-handling", errorHandling("a.go", 42))).not.toBe(
      recordKey("error-handling", errorHandling("b.go", 42)),
    );
  });

  it("still treats the identical fact as identical, so real duplicates merge", () => {
    expect(recordKey("error-handling", errorHandling("a.go", 42))).toBe(
      recordKey("error-handling", errorHandling("a.go", 42)),
    );
  });

  it("keeps two auth annotations apart by location", () => {
    const at = (relPath: string, line: number) => ({
      rootName: "svc",
      symbolId: null,
      mechanism: "guard",
      requirement: "AuthGuard",
      source: lineRef("svc", relPath, line),
      provenance: inferred(lineRef("svc", relPath, line), "high"),
    });
    expect(recordKey("auth-annotation", at("a.ts", 3))).not.toBe(
      recordKey("auth-annotation", at("b.ts", 3)),
    );
  });

  it("keeps two transaction boundaries apart by location", () => {
    const at = (relPath: string, line: number) => ({
      rootName: "svc",
      symbolId: null,
      mechanism: "@Transactional",
      propagation: null,
      source: lineRef("svc", relPath, line),
      provenance: inferred(lineRef("svc", relPath, line), "high"),
    });
    expect(recordKey("transaction-boundary", at("A.java", 7))).not.toBe(
      recordKey("transaction-boundary", at("B.java", 7)),
    );
  });
});

describe("keys that include a column", () => {
  it("keeps two outbound calls on one line apart", () => {
    // Two fetches on one line are two calls; sharing a key would silently drop
    // the second at persistence.
    const call = (column: number) => ({
      rootName: "svc",
      target: null,
      kind: "http",
      callerSymbolId: null,
      baseIdentifier: null,
      method: null,
      provenance: {
        resolutionClass: "unresolved" as const,
        source: {
          rootName: "svc",
          relPath: "a.ts",
          startLine: 1,
          endLine: 1,
          startColumn: column,
          endColumn: null,
        },
        unresolvedReason: "built at runtime",
      },
    });

    expect(recordKey("outbound-call", call(5))).not.toBe(recordKey("outbound-call", call(40)));
  });
});
