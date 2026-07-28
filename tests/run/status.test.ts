import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { beginSnapshot, publishOrRefuse } from "../../engine/snapshot/persist.js";
import { snapshotRoot } from "../../engine/snapshot/rootsnapshot.js";
import { walkRoot } from "../../engine/inventory/walk.js";
import { recordInventory } from "../../engine/inventory/persist.js";
import { recordPreflight } from "../../engine/providers/persist.js";
import { runPreflight } from "../../engine/providers/preflight.js";
import type { Provider } from "../../engine/providers/types.js";
import { getStatus } from "../../engine/run/status.js";

let store: Store;
let workDir: string;

function write(root: string, relativePath: string, contents: string): void {
  const full = join(workDir, root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function fakeProvider(id: string, available: boolean): Provider {
  return {
    id,
    version: "1.0.0",
    capabilities: () => [],
    preflight: () => (available ? { available: true, version: "1.0.0" } : { available: false, reason: "nope" }),
  };
}

beforeEach(() => {
  store = openStore(IN_MEMORY);
  workDir = mkdtempSync(join(tmpdir(), "pa-status-"));
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("getStatus — never analyzed", () => {
  it("reports analyzed: false for a workspace path with no rows at all", () => {
    const status = getStatus(store, "/never/seen");
    expect(status).toEqual({ workspacePath: "/never/seen", analyzed: false });
  });

  it("reports analyzed: false when only an orphaned unpublished snapshot exists", () => {
    write("alpha", "index.ts", "export const a = 1;\n");
    const root = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false });
    beginSnapshot(store, workDir, [root], "2020-01-01T00:00:00.000Z");
    // Deliberately never published — simulates a run that failed before publish.

    const status = getStatus(store, workDir);
    expect(status).toEqual({ workspacePath: workDir, analyzed: false });
  });
});

describe("getStatus — published snapshot", () => {
  it("reports source roots, disposition counts, and provider checks for the latest published snapshot", () => {
    write("alpha", "index.ts", "export const a = 1;\n");
    write("alpha", ".DS_Store", "junk");
    const root = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false });

    const handle = beginSnapshot(store, workDir, [root], "2020-01-01T00:00:00.000Z");
    const walkResult = walkRoot(root.path);
    recordInventory(store, handle.roots[0]!.id, walkResult);

    const providerReport = runPreflight([fakeProvider("x", true)]);
    recordPreflight(store, handle.snapshotId, providerReport, "2020-01-01T00:00:00.000Z");

    publishOrRefuse(store, handle, [root], "2020-01-01T00:00:05.000Z");

    const status = getStatus(store, workDir);

    expect(status.analyzed).toBe(true);
    expect(status.snapshotId).toBe(handle.snapshotId);
    expect(status.publishedAt).toBe("2020-01-01T00:00:05.000Z");

    const alphaStatus = status.roots?.find((r) => r.name === "alpha");
    expect(alphaStatus?.vcs).toBe("none");
    const analyzedCount = alphaStatus?.counts.find((c) => c.disposition === "analyzed")?.count;
    const excludedCount = alphaStatus?.counts.find((c) => c.disposition === "excluded")?.count;
    expect(analyzedCount).toBe(1);
    expect(excludedCount).toBe(1);

    expect(status.providerChecks).toEqual([
      { providerId: "x", version: "1.0.0", available: true, reason: null, checkedAt: "2020-01-01T00:00:00.000Z" },
    ]);
  });

  it("ignores an orphaned unpublished snapshot even when it is newer than a published one", () => {
    write("alpha", "index.ts", "export const a = 1;\n");
    const root = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false });

    const published = beginSnapshot(store, workDir, [root], "2020-01-01T00:00:00.000Z");
    publishOrRefuse(store, published, [root], "2020-01-01T00:00:05.000Z");

    // A later run captured the same content but never published — must not shadow the published one.
    beginSnapshot(store, workDir, [root], "2020-02-01T00:00:00.000Z");

    const status = getStatus(store, workDir);
    expect(status.snapshotId).toBe(published.snapshotId);
    expect(status.publishedAt).toBe("2020-01-01T00:00:05.000Z");
  });

  it("breaks a published_at tie deterministically, by the later snapshot", () => {
    // published_at has millisecond resolution, so two runs in quick succession
    // can share one. Honest about what this test does: it passes with or
    // without the explicit `id DESC` tie-break, because SQLite's current query
    // plan already returns the higher id. It is here to pin the contract, so
    // that a future index or schema change that flips the incidental ordering
    // is caught rather than silently changing which snapshot status reports.
    write("alpha", "index.ts", "export const a = 1;\n");
    const root = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false });

    const first = beginSnapshot(store, workDir, [root], "2020-01-01T00:00:00.000Z");
    publishOrRefuse(store, first, [root], "2020-01-01T00:00:05.000Z");

    const second = beginSnapshot(store, workDir, [root], "2020-01-01T00:00:05.000Z");
    publishOrRefuse(store, second, [root], "2020-01-01T00:00:05.000Z"); // identical timestamp

    expect(second.snapshotId).toBeGreaterThan(first.snapshotId);
    expect(getStatus(store, workDir).snapshotId).toBe(second.snapshotId);
  });

  it("reports the most recently published snapshot when more than one exists", () => {
    write("alpha", "index.ts", "export const a = 1;\n");
    const root = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false });

    const first = beginSnapshot(store, workDir, [root], "2020-01-01T00:00:00.000Z");
    publishOrRefuse(store, first, [root], "2020-01-01T00:00:05.000Z");

    write("alpha", "index.ts", "export const a = 2;\n");
    const secondRoot = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false });
    const second = beginSnapshot(store, workDir, [secondRoot], "2020-01-02T00:00:00.000Z");
    publishOrRefuse(store, second, [secondRoot], "2020-01-02T00:00:05.000Z");

    const status = getStatus(store, workDir);
    expect(status.snapshotId).toBe(second.snapshotId);
    expect(status.publishedAt).toBe("2020-01-02T00:00:05.000Z");
  });
});
