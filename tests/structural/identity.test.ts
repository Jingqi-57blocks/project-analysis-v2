import { describe, expect, it } from "vitest";

import { fileId, symbolId, type SymbolIdParts } from "../../engine/structural/identity.js";

function parts(overrides: Partial<SymbolIdParts> = {}): SymbolIdParts {
  return {
    rootName: "svc",
    relPath: "user/service.go",
    kind: "function",
    qualifiedName: "UserService.Create",
    signature: null,
    ...overrides,
  };
}

describe("symbolId", () => {
  it("is deterministic for the same code properties", () => {
    expect(symbolId(parts())).toBe(symbolId(parts()));
  });

  it("derives identity only from the code, so two providers agree independently", () => {
    // The whole merge contract rests on this: nothing provider-assigned takes
    // part, so a second provider computing the id from the same source gets
    // the same string without coordination.
    const fromProviderA = symbolId(parts());
    const fromProviderB = symbolId(parts());
    expect(fromProviderA).toBe(fromProviderB);
  });

  it("distinguishes symbols differing in any single property", () => {
    const base = symbolId(parts());
    expect(symbolId(parts({ rootName: "other" }))).not.toBe(base);
    expect(symbolId(parts({ relPath: "other.go" }))).not.toBe(base);
    expect(symbolId(parts({ kind: "method" }))).not.toBe(base);
    expect(symbolId(parts({ qualifiedName: "UserService.Delete" }))).not.toBe(base);
    expect(symbolId(parts({ signature: "(ctx context.Context) error" }))).not.toBe(base);
  });

  it("distinguishes overloads when a signature is available", () => {
    const one = symbolId(parts({ signature: "(id string) error" }));
    const two = symbolId(parts({ signature: "(id int) error" }));
    expect(one).not.toBe(two);
  });

  it("collapses overloads when no signature is available — the documented gap", () => {
    // Deliberate, not accidental. Inventing a discriminator such as a line
    // number would make identity unstable across unrelated edits, so this
    // ambiguity is left visible for the assembler to surface.
    expect(symbolId(parts({ signature: null }))).toBe(symbolId(parts({ signature: null })));
  });

  it("does not let a delimiter inside one component forge a boundary in another", () => {
    // Without escaping both of these render as "a|b|c|function|f|" and two
    // unrelated symbols silently become one — the worst failure available
    // here, since no later stage could detect the merge.
    const rootHoldsDelimiter = symbolId({
      rootName: "a|b",
      relPath: "c",
      kind: "function",
      qualifiedName: "f",
      signature: null,
    });
    const pathHoldsDelimiter = symbolId({
      rootName: "a",
      relPath: "b|c",
      kind: "function",
      qualifiedName: "f",
      signature: null,
    });

    expect(rootHoldsDelimiter).not.toBe(pathHoldsDelimiter);
  });

  it("does not let a backslash be used to escape its way across a boundary", () => {
    const backslashInRoot = symbolId({
      rootName: "a\\",
      relPath: "b",
      kind: "function",
      qualifiedName: "f",
      signature: null,
    });
    const plainRoot = symbolId({
      rootName: "a",
      relPath: "b",
      kind: "function",
      qualifiedName: "f",
      signature: null,
    });
    expect(backslashInRoot).not.toBe(plainRoot);
  });
});

describe("fileId", () => {
  it("is deterministic and escapes the same way", () => {
    expect(fileId("svc", "a/b.go")).toBe(fileId("svc", "a/b.go"));
    expect(fileId("a|b", "c")).not.toBe(fileId("a", "b|c"));
  });
});
