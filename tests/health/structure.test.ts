import { describe, expect, it } from "vitest";

import { computeStructuralFindings, normalizePath } from "../../engine/health/structure.js";
import { goOperationNear } from "../../engine/datamodel/usage.js";
import { resolved, lineRef } from "../../engine/structural/provenance.js";
import type { DataAccessRecord } from "../../engine/structural/boundaries.js";

function access(rootName: string, entity: string, operation: string): DataAccessRecord {
  return {
    rootName,
    entity,
    operation: operation as DataAccessRecord["operation"],
    mechanism: "orm",
    symbolId: null,
    provenance: resolved(lineRef(rootName, "svc.go", 1), "high"),
  };
}

function findings(dataAccess: readonly DataAccessRecord[]) {
  return computeStructuralFindings({
    dataAccess,
    routes: [],
    entityColumns: new Map(),
    rootNames: ["a", "b"],
  });
}

describe("ownership findings", () => {
  it("reports a table two parts write", () => {
    const result = findings([access("a", "orders", "write"), access("b", "orders", "write")]);
    const shared = result.find((f) => f.id === "tables-written-by-several-services");

    expect(shared).toBeDefined();
    expect(shared!.evidence[0]).toContain("orders");
  });

  it("never counts an undetermined access as a read", () => {
    // Filing it as a read publishes "read by b, written by a" about a part
    // that may well write the table — ownership stated backwards from
    // evidence that said nothing either way.
    const result = findings([access("a", "orders", "write"), access("b", "orders", "unknown")]);

    expect(result.some((f) => f.id === "tables-read-across-a-boundary")).toBe(false);
    expect(result.some((f) => f.id === "accesses-with-no-determined-operation")).toBe(true);
  });

  it("reports a genuine read across a boundary", () => {
    const result = findings([access("a", "orders", "write"), access("b", "orders", "read")]);
    expect(result.some((f) => f.id === "tables-read-across-a-boundary")).toBe(true);
  });

  it("says how many accesses it could not weigh", () => {
    const result = findings([access("a", "orders", "unknown"), access("a", "items", "unknown")]);
    const note = result.find((f) => f.id === "accesses-with-no-determined-operation");
    expect(note!.finding).toContain("2 data accesses");
  });
});

describe("goOperationNear", () => {
  it("finds a verb on a later line, which is how Go chains are written", () => {
    // Requiring the verb to follow the dot immediately left nearly every
    // access in a Go service unclassified, and unclassified then read as
    // "never written".
    const source = 'tx.Table(name).\n\tWhere(map[string]any{"id": 1}).\n\tUpdates(values)\n';
    expect(goOperationNear(source, source.indexOf(".Table("))).toBe("write");
  });

  it("does not borrow the next statement's verb", () => {
    const source = "db.Table(A).Find(&x)\n\tdb.Table(B).Create(&y)\n";
    expect(goOperationNear(source, source.indexOf(".Table("))).toBe("read");
  });

  it("says nothing rather than guessing when no verb follows", () => {
    const source = "q := db.Table(name)\n\treturn q\n";
    expect(goOperationNear(source, source.indexOf(".Table("))).toBe("unknown");
  });

  it("reads a single-line chain", () => {
    const source = "db.Table(name).Where(x).Delete(&y)\n";
    expect(goOperationNear(source, source.indexOf(".Table("))).toBe("delete");
  });
});

describe("normalizePath", () => {
  it("makes two spellings of one route compare equal", () => {
    expect(normalizePath("/v2/users/:id")).toBe(normalizePath("/v2/users/{uid}"));
  });
});
