import { describe, expect, it } from "vitest";

import { selectWorkspace } from "../../engine/workspace/select.js";
import { analyzedRoots } from "../../engine/workspace/types.js";
import { TARGETS } from "../support/targets/registry.js";
import { announceSkip, targetAvailability } from "../support/targets.js";

/**
 * Selection is heuristic, so it is verified against real projects rather than
 * only against constructed trees. The failure that matters is subtle: treating
 * one project as a container decomposes its internal packages into fake roots.
 */

for (const definition of TARGETS) {
  const { available, target, reason } = targetAvailability(definition.id);
  if (!available) announceSkip(`selection on ${definition.id}`, reason);

  describe.skipIf(!available)(`selection on ${definition.id}`, () => {
    it("recognises the target as a container and finds every declared root", () => {
      const selection = selectWorkspace({ paths: [target!.path] });

      expect(selection.mode).toBe("parent");
      expect(analyzedRoots(selection).map((r) => r.name).sort()).toEqual(
        [...definition.roots].sort(),
      );
    });

    it("reflects the target's actual version-control state", () => {
      const selection = selectWorkspace({ paths: [target!.path] });
      const gitRoots = analyzedRoots(selection).filter((r) => r.isGitRepo);

      if (definition.vcs === "git") {
        expect(gitRoots.length).toBe(definition.roots.length);
      } else {
        expect(gitRoots).toEqual([]);
      }
    });

    it("analyzes one root on its own without decomposing it", () => {
      // The real hazard: a project's own internal/, docs/ and build/ folders
      // becoming roots because the project was mistaken for a container.
      const first = definition.roots[0]!;
      const rootPath = target!.roots.find((r) => r.name === first)!.path;

      const selection = selectWorkspace({ paths: [rootPath] });

      expect(selection.mode).toBe("single-root");
      expect(analyzedRoots(selection).map((r) => r.name)).toEqual([first]);
    });

    it("excludes a root while still recording it", () => {
      const dropped = definition.roots[0]!;
      const selection = selectWorkspace({ paths: [target!.path], exclude: [dropped] });

      expect(analyzedRoots(selection).length).toBe(definition.roots.length - 1);
      expect(selection.roots.length).toBe(definition.roots.length);
      expect(selection.roots.find((r) => r.name === dropped)?.selected).toBe(false);
    });

    it("narrows to a single root by request", () => {
      const kept = definition.roots[0]!;
      const selection = selectWorkspace({ paths: [target!.path], include: [kept] });

      expect(analyzedRoots(selection).map((r) => r.name)).toEqual([kept]);
    });
  });
}
