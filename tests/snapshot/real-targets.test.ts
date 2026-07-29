import { describe, expect, it } from "vitest";

import { selectWorkspace } from "../../engine/workspace/select.js";
import { analyzedRoots } from "../../engine/workspace/types.js";
import { snapshotRoot } from "../../engine/snapshot/rootsnapshot.js";
import { workspaceIdentity } from "../../engine/snapshot/identity.js";
import { digestDirectory } from "../../engine/targets/digest.js";
import { TARGETS } from "../../engine/targets/registry.js";
import { announceSkip, targetAvailability } from "../support/targets.js";

/**
 * Confirms the snapshot layer against real projects, not only constructed
 * trees, and — since this stage reads real source directly — that reading it
 * really is read-only.
 */

for (const definition of TARGETS) {
  const { available, target, reason } = targetAvailability(definition.id);
  if (!available) announceSkip(`snapshot on ${definition.id}`, reason);

  describe.skipIf(!available)(`snapshot on ${definition.id}`, () => {
    it("reflects the target's declared version-control state", { timeout: 300_000 }, () => {
      const selection = selectWorkspace({ paths: [target!.path] });
      const roots = analyzedRoots(selection).map((r) =>
        snapshotRoot({ name: r.name, path: r.path, isGitRepo: r.isGitRepo }),
      );

      if (definition.vcs === "git") {
        expect(roots.every((r) => r.vcs === "git")).toBe(true);
        expect(roots.every((r) => r.commitSha !== null)).toBe(true);
      } else {
        expect(roots.every((r) => r.vcs === "none")).toBe(true);
        expect(roots.every((r) => r.commitSha === null)).toBe(true);
      }
    });

    it("gives every root a non-empty content digest", { timeout: 300_000 }, () => {
      const selection = selectWorkspace({ paths: [target!.path] });
      const roots = analyzedRoots(selection).map((r) =>
        snapshotRoot({ name: r.name, path: r.path, isGitRepo: r.isGitRepo }),
      );

      for (const root of roots) {
        expect(root.contentDigest.length, `${root.name} digest`).toBeGreaterThan(0);
      }
    });

    it("produces the same workspace identity across repeated snapshots", { timeout: 300_000 }, () => {
      const selection = selectWorkspace({ paths: [target!.path] });
      const snap = () =>
        workspaceIdentity(
          analyzedRoots(selection).map((r) =>
            snapshotRoot({ name: r.name, path: r.path, isGitRepo: r.isGitRepo }),
          ),
        );

      expect(snap()).toBe(snap());
    });

    it("leaves target source unchanged after being snapshotted", { timeout: 300_000 }, () => {
      // Same read-only guarantee already asserted for derived variants
      // (tests/targets/derive.test.ts), applied here: the whole-root digest
      // before and after must match, since snapshotting only reads.
      const selection = selectWorkspace({ paths: [target!.path] });
      const firstRoot = analyzedRoots(selection)[0]!;

      const before = digestDirectory(firstRoot.path);
      snapshotRoot({ name: firstRoot.name, path: firstRoot.path, isGitRepo: firstRoot.isGitRepo });
      const after = digestDirectory(firstRoot.path);

      expect(after).toBe(before);
    });
  });
}
