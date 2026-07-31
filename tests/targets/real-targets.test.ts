import { describe, expect, it } from "vitest";

import { TARGETS } from "../support/targets/registry.js";
import { announceSkip, targetAvailability } from "../support/targets.js";

/**
 * Integration checks against the real projects. They live outside the
 * repository and are not present on every machine, so each suite skips with a
 * printed reason rather than failing or silently passing.
 */

for (const definition of TARGETS) {
  const { available, target, reason } = targetAvailability(definition.id);
  if (!available) announceSkip(definition.id, reason);

  describe.skipIf(!available)(`target ${definition.id}`, () => {
    it("has every declared root present on disk", () => {
      expect(target?.missingRoots).toEqual([]);
    });

    it("matches its declared version-control mode", () => {
      const gitRoots = target!.roots.filter((r) => r.isGitRepo);
      if (definition.vcs === "git") {
        expect(gitRoots.length, "expected every root to be a git repository").toBe(
          target!.roots.length,
        );
      } else {
        expect(gitRoots.map((r) => r.name), "expected no root to be a git repository").toEqual([]);
      }
    });
  });
}

describe("registry coverage", () => {
  it("declares distinct root counts, so nothing can assume a fixed N", () => {
    const counts = new Set(TARGETS.map((t) => t.roots.length));
    expect(counts.size).toBeGreaterThan(1);
  });
});
