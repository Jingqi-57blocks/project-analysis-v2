import { describe, expect, it } from "vitest";

import { declared, lineRef } from "../../../engine/structural/provenance.js";
import { symbolId } from "../../../engine/structural/identity.js";
import type { SymbolRecord } from "../../../engine/structural/code.js";
import { deriveTestRelations } from "../../../engine/providers/tests/provider.js";

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
});
