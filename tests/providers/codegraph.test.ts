import { describe, expect, it } from "vitest";

import {
  isSymbolNode,
  normalizeKind,
  nodeSymbolId,
  parseRouteName,
  toCallEdge,
  toImport,
  toRoute,
  toSymbol,
} from "../../engine/providers/codegraph/normalize.js";
import {
  batchRelations,
  calleeKey,
  codegraphCapabilities,
  PROVIDER_ID,
} from "../../engine/providers/codegraph/provider.js";
import { capabilityFor, ANY_LANGUAGE, declaredKinds } from "../../engine/structural/provider.js";
import { createSourceFileProvider } from "../../engine/providers/sourcefiles/provider.js";
import type { CodeGraphNode } from "../../engine/providers/codegraph/cli.js";
import type { CodeGraphSnapshot } from "../../engine/providers/codegraph/batch.js";

function node(overrides: Partial<CodeGraphNode> = {}): CodeGraphNode {
  return {
    id: "method:abc",
    kind: "method",
    name: "Activation",
    qualifiedName: "OAuthService::Activation",
    filePath: "internal/service.go",
    language: "go",
    startLine: 30,
    endLine: 30,
    startColumn: 1,
    endColumn: 77,
    signature: "(c context.Context) error",
    visibility: null,
    isExported: false,
    ...overrides,
  };
}

describe("normalizeKind", () => {
  it("maps a genuine spelling difference", () => {
    expect(normalizeKind("type_alias")).toBe("type-alias");
  });

  it("passes an unfamiliar kind through unchanged rather than coercing it", () => {
    // The reason the model's symbol-kind union is open: a Rust trait or a
    // Swift protocol must keep its own name, not be forced into the nearest
    // wrong one or flattened to "unknown".
    expect(normalizeKind("trait")).toBe("trait");
    expect(normalizeKind("protocol")).toBe("protocol");
    expect(normalizeKind("something_new")).toBe("something_new");
  });
});

describe("isSymbolNode", () => {
  it("treats files, imports and routes as not symbols", () => {
    expect(isSymbolNode(node({ kind: "file" }))).toBe(false);
    expect(isSymbolNode(node({ kind: "import" }))).toBe(false);
    expect(isSymbolNode(node({ kind: "route" }))).toBe(false);
  });

  it("treats an unrecognized kind as a symbol rather than dropping it", () => {
    expect(isSymbolNode(node({ kind: "trait" }))).toBe(true);
  });
});

describe("toSymbol", () => {
  it("keeps the signature, which is what distinguishes overloads", () => {
    expect(toSymbol("svc", node()).signature).toBe("(c context.Context) error");
  });

  it("gives two overloads distinct ids", () => {
    const a = nodeSymbolId("svc", node({ signature: "(id string) error" }));
    const b = nodeSymbolId("svc", node({ signature: "(id int) error" }));
    expect(a).not.toBe(b);
  });

  it("reports unknown visibility rather than inferring it from naming", () => {
    // Go encodes visibility in capitalization and CodeGraph reports null.
    // Claiming "public" from an uppercase initial would be our inference
    // presented as the provider's observation.
    expect(toSymbol("svc", node({ visibility: null })).visibility).toBe("unknown");
  });

  it("records the fact as declared, since it was read from the index", () => {
    expect(toSymbol("svc", node()).provenance.resolutionClass).toBe("declared");
  });
});

describe("parseRouteName", () => {
  it("splits a method and path", () => {
    expect(parseRouteName("GET /users")).toEqual({ method: "GET", path: "/users" });
  });

  it("keeps a wildcard path intact", () => {
    expect(parseRouteName("GET /*any")).toEqual({ method: "GET", path: "/*any" });
  });

  it("treats a name with no method as an all-methods route with a null method", () => {
    // Null rather than a "*" sentinel every consumer would have to know to
    // special-case — matching the model's decision.
    expect(parseRouteName("/health")).toEqual({ method: null, path: "/health" });
  });

  it("handles a path containing spaces after the method", () => {
    expect(parseRouteName("POST /a b")).toEqual({ method: "POST", path: "/a b" });
  });
});

describe("toRoute", () => {
  it("leaves the handler unlinked rather than guessing it from proximity", () => {
    const route = toRoute("svc", node({ kind: "route", name: "GET /users" }));
    expect(route.handlerSymbolId).toBeNull();
    expect(route.handlerName).toBeNull();
  });
});

describe("toImport", () => {
  it("keeps the specifier as written and does not invent a resolved path", () => {
    const record = toImport("svc", node({ kind: "import", name: "example.com/pkg/docs" }));
    expect(record.specifier).toBe("example.com/pkg/docs");
    expect(record.resolvedPath).toBeNull();
  });
});

describe("toCallEdge", () => {
  const callerId = nodeSymbolId("svc", node());

  it("resolves a callee that is in the indexed set", () => {
    const edge = toCallEdge(
      "svc",
      callerId,
      { name: "Helper", kind: "function", filePath: "internal/util.go", startLine: 10 },
      () => callerId,
    );
    expect(edge.calleeId).toBe(callerId);
    expect(edge.provenance.resolutionClass).toBe("declared");
  });

  it("keeps an unresolvable call as an edge with a reason, rather than dropping it", () => {
    // Dropping it would erase the fact that a call exists, shrinking the graph
    // exactly where the code is hardest to reason about.
    const edge = toCallEdge(
      "svc",
      callerId,
      { name: "ExternalThing", kind: "function", filePath: "vendor/x.go", startLine: 3 },
      () => null,
    );

    expect(edge.calleeId).toBeNull();
    expect(edge.calleeName).toBe("ExternalThing");
    expect(edge.provenance.resolutionClass).toBe("unresolved");
    if (edge.provenance.resolutionClass === "unresolved") {
      expect(edge.provenance.unresolvedReason).toContain("outside the indexed source");
    }
  });
});

describe("declared capabilities", () => {
  const capabilities = codegraphCapabilities();

  it("declares partial rather than full support for call edges, with the reasons", () => {
    const declaration = capabilityFor(capabilities, "call-edge", "go");
    expect(declaration?.support).toBe("partial");
    expect(declaration?.limits.join(" ")).toContain("calls into dependencies do not appear");
  });

  it("declares what it cannot supply instead of staying silent", () => {
    // Silence would be indistinguishable from an oversight; a declared "none"
    // lets the coverage matrix tell a refusal from a gap nobody considered.
    for (const kind of ["export", "data-access"] as const) {
      expect(capabilityFor(capabilities, kind, "go")?.support, kind).toBe("none");
    }
    expect(capabilityFor(capabilities, "reference", "go")?.support).toBe("partial");
    expect(capabilityFor(capabilities, "type-relation", "go")?.support).toBe("partial");
  });

  it("does not claim kinds another provider is responsible for", () => {
    const kinds = declaredKinds(capabilities);
    expect(kinds).not.toContain("package-dependency");
    expect(kinds).not.toContain("outbound-call");
  });

  it("claims the kinds it actually normalizes", () => {
    // No source-file: the inventory visited every file already, and two
    // readers of one fact can only disagree.
    expect(declaredKinds(capabilities)).toEqual([
      "call-edge",
      "import",
      "reference",
      "route",
      "symbol",
      "type-relation",
    ]);
  });

  it("reads the batch index in one pass and declares the CLI fallback limit", () => {
    expect(capabilityFor(capabilities, "symbol", ANY_LANGUAGE)?.limits.join(" ")).toContain("batch index");
    expect(capabilityFor(capabilities, "symbol", ANY_LANGUAGE)?.limits.join(" ")).toContain("fallback");
  });

  it("identifies itself with a stable provider id", () => {
    expect(PROVIDER_ID).toBe("codegraph");
  });
});

describe("batch relations", () => {
  const snapshot: CodeGraphSnapshot = {
    nodes: [
      {
        nativeId: "fn:a",
        kind: "function",
        name: "Entry",
        filePath: "svc-a/main.go",
        startLine: 10,
        endLine: 20,
        metadata: { qualifiedName: "Entry", language: "go", signature: "()" },
      },
      {
        nativeId: "method:a",
        kind: "method",
        name: "Run",
        filePath: "svc-a/service.go",
        startLine: 30,
        endLine: 40,
        metadata: { qualifiedName: "Worker::Run", language: "go", signature: "(ctx)" },
      },
      {
        nativeId: "type:a",
        kind: "struct",
        name: "Worker",
        filePath: "svc-a/service.go",
        startLine: 3,
        endLine: 8,
        metadata: { qualifiedName: "Worker", language: "go" },
      },
      {
        nativeId: "iface:a",
        kind: "interface",
        name: "Runner",
        filePath: "svc-a/contracts.go",
        startLine: 1,
        endLine: 5,
        metadata: { qualifiedName: "Runner", language: "go" },
      },
    ],
    edges: [
      { nativeId: "1", kind: "calls", fromNativeId: "fn:a", toNativeId: "method:a", filePath: "svc-a/main.go", startLine: 15 },
      { nativeId: "2", kind: "instantiates", fromNativeId: "fn:a", toNativeId: "type:a", filePath: "svc-a/main.go", startLine: 12 },
      { nativeId: "3", kind: "implements", fromNativeId: "type:a", toNativeId: "iface:a", filePath: "svc-a/service.go", startLine: 3 },
    ],
    unresolvedReferences: [],
    metadata: {
      codegraphVersion: "1.5.0",
      schemaVersion: "8",
      indexRoot: "/idx",
      rootPrefixes: ["svc-a"],
      nodeCount: 4,
      edgeCount: 3,
    },
    truncation: { truncated: false, limit: null, reason: null },
  };

  it("imports calls, instantiations and type relations under the index's own symbol identity", () => {
    const result = batchRelations(
      snapshot,
      "/idx",
      ["/idx/svc-a"],
      { name: "svc-a", path: "/idx/svc-a", analyzedFiles: ["main.go", "service.go", "contracts.go"] },
    );

    // The endpoint carries the index's own signature. It used to be stripped
    // wherever the in-process reader owned the file, so that an edge and the
    // symbol it points at shared one identity. With one symbol source there is
    // no second identity to match, and dropping the signature now would be the
    // thing that made an edge point at a symbol the model does not hold.
    expect(result.callEdges).toHaveLength(1);
    expect(result.callEdges[0]!.callerId).toBe(nodeSymbolId("svc-a", node({
      kind: "function",
      name: "Entry",
      qualifiedName: "Entry",
      filePath: "main.go",
      signature: "()",
    })));
    expect(result.references).toMatchObject([
      { kind: "instantiate", fromSymbolId: result.callEdges[0]!.callerId },
    ]);
    expect(result.typeRelations).toMatchObject([
      { relation: "implements", subtypeId: result.references[0]!.symbolId, supertypeName: "Runner" },
    ]);
  });
});

describe("callee resolution", () => {
  it("leaves an ambiguous name unresolved rather than picking a winner", () => {
    // Two symbols in one file can share a simple name — User.Save and
    // Account.Save are both "Save" in models.go — and a callee relation
    // carries only the simple name. Resolving to whichever was indexed last
    // would record a wrong callee as `declared`.
    const save1 = node({ kind: "method", name: "Save", qualifiedName: "User::Save", filePath: "models.go", signature: "(u *User) error" });
    const save2 = node({ kind: "method", name: "Save", qualifiedName: "Account::Save", filePath: "models.go", signature: "(a *Account) error" });

    const byName = new Map<string, ReturnType<typeof nodeSymbolId>>();
    const ambiguous = new Set<string>();
    for (const n of [save1, save2]) {
      const key = `${n.filePath}::${n.name}`;
      if (byName.has(key)) ambiguous.add(key);
      else byName.set(key, nodeSymbolId("svc", n));
    }

    const resolve = (r: { name: string; filePath: string }) => {
      const key = `${r.filePath}::${r.name}`;
      return ambiguous.has(key) ? null : (byName.get(key) ?? null);
    };

    const edge = toCallEdge(
      "svc",
      nodeSymbolId("svc", node()),
      { name: "Save", kind: "method", filePath: "models.go", startLine: 80 },
      resolve,
    );

    expect(edge.calleeId).toBeNull();
    expect(edge.provenance.resolutionClass).toBe("unresolved");
    expect(edge.calleeName).toBe("Save");
  });

  it("does not fabricate line 1 when the callee's line is unknown", () => {
    // The model documents that an unknown location stays null rather than
    // being faked into a real-looking one.
    const edge = toCallEdge(
      "svc",
      nodeSymbolId("svc", node()),
      { name: "Helper", kind: "function", filePath: "util.go", startLine: null },
      () => null,
    );

    expect(edge.provenance.source.startLine).toBeNull();
    expect(edge.provenance.source.relPath).toBe("util.go");
  });
});

describe("the callee join", () => {
  it("keys a relation from the index root the same way as a scoped symbol", () => {
    // Symbols are stripped to their own root; callee relations come back
    // relative to the directory holding every root. Keyed as they arrive,
    // the two sides never meet and every call edge resolves to null.
    expect(calleeKey("svc/main.go", "Helper", "svc/")).toBe(
      calleeKey("main.go", "Helper"),
    );
  });

  it("leaves a path that does not carry the prefix alone", () => {
    expect(calleeKey("main.go", "Helper", "svc/")).toBe("main.go::Helper");
  });
});

describe("source files from the inventory", () => {
  it("records one per analyzed file, with the language the extension states", () => {
    const contribution = createSourceFileProvider().extract({
      name: "svc",
      path: "/w/svc",
      analyzedFiles: ["main.go", "app/handler.ts", "README.md", "Makefile"],
    });

    expect(
      contribution.records["source-file"].map((file) => [file.relPath, file.language]),
    ).toEqual([
      ["main.go", "go"],
      ["app/handler.ts", "typescript"],
      ["README.md", "markdown"],
      // No extension states a language, so none is recorded rather than guessed.
      ["Makefile", null],
    ]);
  });
});
