import { describe, expect, it } from "vitest";

import { workspaceIdentity } from "../../engine/snapshot/identity.js";
import type { RootSnapshot } from "../../engine/snapshot/rootsnapshot.js";

function root(name: string, contentDigest: string): RootSnapshot {
  return {
    name,
    path: `/workspace/${name}`,
    contentDigest,
    vcs: "none",
    commitSha: null,
    branch: null,
    dirty: null,
  };
}

describe("workspaceIdentity", () => {
  it("is stable across calls on the same roots", () => {
    const roots = [root("a", "d1"), root("b", "d2")];
    expect(workspaceIdentity(roots)).toBe(workspaceIdentity(roots));
  });

  it("does not depend on root order", () => {
    const forward = [root("a", "d1"), root("b", "d2"), root("c", "d3")];
    const shuffled = [root("c", "d3"), root("a", "d1"), root("b", "d2")];

    expect(workspaceIdentity(forward)).toBe(workspaceIdentity(shuffled));
  });

  it("changes when any root's digest changes", () => {
    const before = [root("a", "d1"), root("b", "d2")];
    const after = [root("a", "d1"), root("b", "changed")];

    expect(workspaceIdentity(before)).not.toBe(workspaceIdentity(after));
  });

  it("changes when a root is added", () => {
    const before = [root("a", "d1")];
    const after = [root("a", "d1"), root("b", "d2")];

    expect(workspaceIdentity(before)).not.toBe(workspaceIdentity(after));
  });

  it("changes when a root is removed", () => {
    const before = [root("a", "d1"), root("b", "d2")];
    const after = [root("a", "d1")];

    expect(workspaceIdentity(before)).not.toBe(workspaceIdentity(after));
  });

  it("distinguishes a rename from an edit", () => {
    // Same digest under a different name must not collide with the same name
    // under a different digest — otherwise two structurally different
    // workspaces could share an identity.
    const renamed = workspaceIdentity([root("b", "d1")]);
    const edited = workspaceIdentity([root("a", "d2")]);
    const original = workspaceIdentity([root("a", "d1")]);

    expect(renamed).not.toBe(original);
    expect(edited).not.toBe(original);
  });

  it("produces the same identity for an empty root list on repeated calls", () => {
    expect(workspaceIdentity([])).toBe(workspaceIdentity([]));
  });
});
