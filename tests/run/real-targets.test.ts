import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestDirectory } from "../../engine/targets/digest.js";
import { resolveTarget } from "../support/targets/resolve.js";
import { runAnalyze } from "../../engine/run/analyze.js";
import { getStatus } from "../../engine/run/status.js";
import { openStore } from "../../engine/store/open.js";
import { announceSkip, codeIndexAvailability } from "../support/targets.js";

/**
 * One full end-to-end run against a single real root (wcp-auth), confirming
 * the whole orchestration works on real source and that running it changes
 * nothing on disk under the target — the same read-only guarantee every
 * other stage has been checked against.
 */

const wcpV2 = resolveTarget("wcp-v2");
if (!wcpV2.ok) announceSkip("run on wcp-auth", wcpV2.unavailable.reason);

const codeIndex = codeIndexAvailability();
if (!codeIndex.available) announceSkip("run on wcp-auth", codeIndex.reason);

const canRun = wcpV2.ok && codeIndex.available;

let tmpRoot: string | undefined;

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

describe.skipIf(!canRun)("runAnalyze on wcp-auth", () => {
  it("analyzes wcp-auth end to end and leaves it unchanged on disk", { timeout: 600_000 }, () => {
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

      // The run leaves a knowledge base behind, not just an inventory. Before
      // one pipeline, `analyze` published a snapshot with no facts in it and
      // everything downstream re-read the source.
      const structural = store.all<{ kind: string; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM structural_records WHERE snapshot_id = ? GROUP BY kind",
        [result.snapshotId],
      );
      const byKind = new Map(structural.map((row) => [row.kind, row.n]));
      expect(byKind.get("route") ?? 0).toBeGreaterThan(10);
      expect(byKind.get("symbol") ?? 0).toBeGreaterThan(50);

      const derived = store.all<{ kind: string; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM derived_records WHERE snapshot_id = ? GROUP BY kind",
        [result.snapshotId],
      );
      const derivedByKind = new Map(derived.map((row) => [row.kind, row.n]));
      expect(derivedByKind.get("run-context")).toBe(1);
      expect(derivedByKind.get("coverage-note") ?? 0).toBeGreaterThan(0);
      // Rules stated in the project's own vocabulary, which is the join this
      // stage exists to make: conditions come from one reader, the constants
      // that explain them from another, and neither knows about the other.
      expect(derivedByKind.get("business-rule") ?? 0).toBeGreaterThan(0);
      expect(derivedByKind.get("value-set") ?? 0).toBeGreaterThan(0);
      expect(derivedByKind.get("trace") ?? 0).toBeGreaterThan(0);

      // The run id on the facts is the run id the caller was handed: an
      // overview and a module report drawn separately must be the same run.
      const context = store.get<{ payload: string }>(
        "SELECT payload FROM derived_records WHERE snapshot_id = ? AND kind = 'run-context'",
        [result.snapshotId],
      );
      expect(JSON.parse(context!.payload).runId).toBe(result.runId);
    } finally {
      store.close();
    }
  });
});
