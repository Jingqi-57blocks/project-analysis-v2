import { describe, expect, it } from "vitest";

import {
  canonicalFileId,
  canonicalSymbolId,
  type CanonicalSymbolParts,
  detectCollisions,
  normalizePath,
  reconcile,
  tryCanonicalSymbolId,
} from "../../../engine/contracts/shared-fact/canonical.js";

const base: CanonicalSymbolParts = {
  repo: "api",
  path: "leave/service.go",
  kind: "function",
  qualifiedName: "Service.Approve",
  signature: "func()",
  scopePath: null,
};

describe("canonical file identity", () => {
  it("is stable and repo-scoped", () => {
    expect(canonicalFileId("api", "a/b.go")).toBe(canonicalFileId("api", "a/b.go"));
    expect(canonicalFileId("api", "a/b.go")).not.toBe(canonicalFileId("web", "a/b.go"));
  });

  it("normalizes the path before identity", () => {
    expect(canonicalFileId("api", "./a//b.go")).toBe(canonicalFileId("api", "a/b.go"));
    expect(canonicalFileId("api", "a/x/../b.go")).toBe(canonicalFileId("api", "a/b.go"));
  });

  it("gives a generated file a stable id like any other", () => {
    expect(canonicalFileId("api", "gen/docs.go")).toBe(canonicalFileId("api", "gen/docs.go"));
  });
});

describe("canonical symbol identity", () => {
  it("is stable for the same parts and independent of where it was observed", () => {
    expect(canonicalSymbolId(base)).toBe(canonicalSymbolId({ ...base }));
  });

  it("keeps overloads apart by signature", () => {
    expect(canonicalSymbolId(base)).not.toBe(canonicalSymbolId({ ...base, signature: "func(int)" }));
  });

  it("keeps same-name locals apart by scope, and the same name apart across repos", () => {
    expect(canonicalSymbolId(base)).not.toBe(canonicalSymbolId({ ...base, scopePath: "Outer" }));
    expect(canonicalSymbolId(base)).not.toBe(canonicalSymbolId({ ...base, repo: "web" }));
  });
});

describe("tryCanonicalSymbolId", () => {
  it("leaves an anonymous, scopeless symbol unresolved rather than merging it", () => {
    expect(tryCanonicalSymbolId({ ...base, qualifiedName: "", scopePath: null }).kind).toBe("unresolved");
  });

  it("gives an id to an anonymous symbol that has a scope", () => {
    expect(tryCanonicalSymbolId({ ...base, qualifiedName: "", scopePath: "handler#3" }).kind).toBe("exact");
  });
});

describe("reconcile", () => {
  it("resolves zero/one/many to unresolved/exact/candidate", () => {
    const a = canonicalSymbolId(base);
    const b = canonicalSymbolId({ ...base, signature: "func(int)" });
    expect(reconcile("X", []).kind).toBe("unresolved");
    expect(reconcile("X", [a]).kind).toBe("exact");
    const many = reconcile("X", [a, b]);
    expect(many.kind).toBe("candidate");
    if (many.kind === "candidate") expect(many.ids).toHaveLength(2);
  });
});

describe("detectCollisions", () => {
  it("flags one id claimed by two different things", () => {
    const id = canonicalSymbolId(base);
    const collisions = detectCollisions([
      { id, distinct: "Service.Approve" },
      { id, distinct: "Other.Approve" },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.distinctValues).toEqual(["Other.Approve", "Service.Approve"]);
  });

  it("reports nothing when each id has one claimant", () => {
    expect(detectCollisions([{ id: canonicalSymbolId(base), distinct: "a" }])).toHaveLength(0);
  });
});

describe("normalizePath", () => {
  it("collapses ./, // and ..", () => {
    expect(normalizePath("./a//b/../c")).toBe("a/c");
    expect(normalizePath("a\\b")).toBe("a/b");
  });
});
