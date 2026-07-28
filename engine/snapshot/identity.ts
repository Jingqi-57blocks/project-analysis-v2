import { createHash } from "node:crypto";

import type { RootSnapshot } from "./rootsnapshot.js";

/**
 * A single identity for a whole workspace, from its roots' content digests.
 *
 * Deterministic regardless of root order — roots are unordered and
 * interchangeable throughout this tool, so their identity must not depend on
 * how they happened to be discovered or listed.
 */
export function workspaceIdentity(roots: readonly RootSnapshot[]): string {
  const sorted = [...roots].sort((a, b) => a.name.localeCompare(b.name));

  const hash = createHash("sha256");
  for (const root of sorted) {
    hash.update(root.name);
    hash.update("\0");
    hash.update(root.contentDigest);
    hash.update("\0");
  }
  return hash.digest("hex");
}
