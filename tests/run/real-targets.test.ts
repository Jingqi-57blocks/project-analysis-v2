import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestDirectory } from "../../engine/targets/digest.js";
import { resolveTarget } from "../../engine/targets/resolve.js";
import { runAnalyze } from "../../engine/run/analyze.js";
import { getStatus } from "../../engine/run/status.js";
import { openStore } from "../../engine/store/open.js";
import { announceSkip } from "../support/targets.js";

/**
 * One full end-to-end run against a single real root (wcp-auth), confirming
 * the whole orchestration works on real source and that running it changes
 * nothing on disk under the target — the same read-only guarantee every
 * other stage has been checked against.
 */

const wcpV2 = resolveTarget("wcp-v2");
if (!wcpV2.ok) announceSkip("run on wcp-auth", wcpV2.unavailable.reason);

let tmpRoot: string | undefined;

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

describe.skipIf(!wcpV2.ok)("runAnalyze on wcp-auth", () => {
  it("analyzes wcp-auth end to end and leaves it unchanged on disk", () => {
    if (!wcpV2.ok) return;
    const authRoot = wcpV2.target.roots.find((r) => r.name === "wcp-auth");
    expect(authRoot?.present, "wcp-auth not present").toBe(true);

    tmpRoot = mkdtempSync(join(tmpdir(), "pa-run-real-target-"));
    const dbPath = join(tmpRoot, "kb.sqlite");

    const before = digestDirectory(authRoot!.path);
    const result = runAnalyze({ paths: [authRoot!.path], dbPath });
    const after = digestDirectory(authRoot!.path);

    expect(after).toBe(before);

    expect(result.roots).toHaveLength(1);
    const root = result.roots[0]!;
    expect(root.name).toBe("wcp-auth");
    expect(root.vcs).toBe("git");
    expect(root.commitSha).not.toBeNull();
    expect(root.counts.analyzed).toBeGreaterThan(30);
    expect(root.counts.failed).toBe(0);

    const store = openStore(dbPath);
    try {
      const status = getStatus(store, authRoot!.path);
      expect(status.analyzed).toBe(true);
      expect(status.snapshotId).toBe(result.snapshotId);
      expect(status.roots?.[0]?.name).toBe("wcp-auth");
    } finally {
      store.close();
    }
  });
});
