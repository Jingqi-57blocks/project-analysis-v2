import { describe, expect, it } from "vitest";

import { declared, lineRef } from "../../engine/structural/provenance.js";
import { symbolId } from "../../engine/structural/identity.js";
import type { SymbolRecord } from "../../engine/structural/code.js";
import { deriveTestRelations, isTestPath } from "../../engine/kb/test-relations.js";

function symbol(name: string, relPath: string): SymbolRecord {
  return {
    id: symbolId({ rootName: "svc", relPath, kind: "function", qualifiedName: name, signature: null }),
    name,
    qualifiedName: name,
    kind: "function",
    visibility: "unknown",
    signature: null,
    containerId: null,
    provenance: declared(lineRef("svc", relPath, 10, 20)),
  };
}

describe("isTestPath", () => {
  it("recognizes conventional test paths across languages", () => {
    for (const path of [
      "internal/user_test.go",
      "src/__tests__/a.ts",
      "tests/test_thing.py",
      "src/a.spec.ts",
      "src/main/UserTests.java",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it("does not treat production code as a test", () => {
    // `latest` and `contest` both end in "test"; a substring match would call
    // them tests and attribute production symbols to coverage.
    for (const path of ["internal/user.go", "src/latest.ts", "src/contest.js"]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });
});

describe("deriveTestRelations", () => {
  it("ties a test to the production symbol it calls — a resolved 'covers' relation located at the test file", () => {
    const test = symbol("TestCreate", "user_test.go");
    const prod = symbol("Create", "user.go");

    const relations = deriveTestRelations("svc", {
      symbols: [test, prod],
      callEdges: [
        {
          callerId: test.id,
          calleeId: prod.id,
          calleeName: "Create",
          provenance: declared(lineRef("svc", "user_test.go", 12)),
        },
      ],
    });

    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ targetName: "Create", relation: "covers", testSymbolId: test.id });
    // The edge is resolvable, so the relation is resolved and sits at the test file.
    expect(relations[0]!.provenance.resolutionClass).toBe("resolved");
    expect(relations[0]!.provenance.source.relPath).toBe("user_test.go");
  });

  it("records a test with no outgoing edge as an 'unknown' relation, not a drop", () => {
    const test = symbol("TestOrphan", "orphan_test.go");

    const relations = deriveTestRelations("svc", { symbols: [test], callEdges: [] });

    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ relation: "unknown", targetSymbolId: null, targetName: null });
    expect(relations[0]!.provenance.resolutionClass).toBe("unresolved");
  });

  it("produces nothing when no symbol lives at a test-convention path", () => {
    const prod = symbol("Create", "user.go");
    const helper = symbol("build", "internal/build.go");

    const relations = deriveTestRelations("svc", {
      symbols: [prod, helper],
      callEdges: [
        {
          callerId: helper.id,
          calleeId: prod.id,
          calleeName: "Create",
          provenance: declared(lineRef("svc", "internal/build.go", 3)),
        },
      ],
    });

    expect(relations).toEqual([]);
  });

  it("ignores a test calling another test, which is a helper rather than coverage", () => {
    const test = symbol("TestA", "a_test.go");
    const helper = symbol("setupB", "b_test.go");

    const relations = deriveTestRelations("svc", {
      symbols: [test, helper],
      callEdges: [
        {
          callerId: test.id,
          calleeId: helper.id,
          calleeName: "setupB",
          provenance: declared(lineRef("svc", "a_test.go", 5)),
        },
      ],
    });

    expect(relations.filter((r) => r.relation === "covers")).toEqual([]);
  });

  it("keeps an unresolved callee as a relation with a name, rather than dropping it", () => {
    const test = symbol("TestX", "x_test.go");

    const relations = deriveTestRelations("svc", {
      symbols: [test],
      callEdges: [
        {
          callerId: test.id,
          calleeId: null,
          calleeName: "SomethingExternal",
          provenance: declared(lineRef("svc", "x_test.go", 9)),
        },
      ],
    });

    expect(relations[0]).toMatchObject({ targetName: "SomethingExternal", targetSymbolId: null });
    expect(relations[0]!.provenance.resolutionClass).toBe("unresolved");
  });
});
