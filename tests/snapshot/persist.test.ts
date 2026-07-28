import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { beginSnapshot, DriftDetectedError, publishOrRefuse } from "../../engine/snapshot/persist.js";
import { snapshotRoot } from "../../engine/snapshot/rootsnapshot.js";
import type { RootSnapshot } from "../../engine/snapshot/rootsnapshot.js";

let store: Store;
let workDir: string;

function write(root: string, relativePath: string, contents: string): void {
  const full = join(workDir, root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function makeRoot(name: string): RootSnapshot {
  return snapshotRoot({ name, path: join(workDir, name), isGitRepo: false });
}

beforeEach(() => {
  store = openStore(IN_MEMORY);
  workDir = mkdtempSync(join(tmpdir(), "pa-persist-"));
  write("alpha", "index.ts", "export const a = 1;\n");
  write("beta", "index.ts", "export const b = 2;\n");
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("beginSnapshot", () => {
  it("records the workspace, an unpublished snapshot, and every root", () => {
    const roots = [makeRoot("alpha"), makeRoot("beta")];
    const handle = beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");

    const snapshotRow = store.get<{ published_at: string | null }>(
      "SELECT published_at FROM snapshots WHERE id = ?",
      [handle.snapshotId],
    );
    expect(snapshotRow?.published_at).toBeNull();

    const rootRows = store.all<{ name: string; content_digest: string; vcs: string | null }>(
      "SELECT name, content_digest, vcs FROM source_roots WHERE snapshot_id = ? ORDER BY name",
      [handle.snapshotId],
    );
    expect(rootRows.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(rootRows.every((r) => r.content_digest.length > 0)).toBe(true);
    expect(rootRows.every((r) => r.vcs === "none")).toBe(true);
  });

  it("returns a row id for every persisted root, matching the database", () => {
    const roots = [makeRoot("alpha"), makeRoot("beta")];
    const handle = beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");

    expect(handle.roots.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);

    for (const persisted of handle.roots) {
      const row = store.get<{ id: number }>("SELECT id FROM source_roots WHERE id = ? AND name = ?", [
        persisted.id,
        persisted.name,
      ]);
      expect(row?.id, `no source_roots row for ${persisted.name}`).toBe(persisted.id);
    }

    // ids are distinct — a real requirement, since inventory attaches files by id.
    expect(new Set(handle.roots.map((r) => r.id)).size).toBe(handle.roots.length);
  });

  it("reuses the same workspace row across snapshots of the same path", () => {
    const first = beginSnapshot(store, workDir, [makeRoot("alpha")], "2020-01-01T00:00:00.000Z");
    const second = beginSnapshot(store, workDir, [makeRoot("alpha")], "2020-01-02T00:00:00.000Z");

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const count = store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workspaces WHERE path = ?",
      [workDir],
    );
    expect(count?.n).toBe(1);
  });

  it("gives the same workspace identity to snapshots of unchanged source", () => {
    const first = beginSnapshot(store, workDir, [makeRoot("alpha")], "2020-01-01T00:00:00.000Z");
    const second = beginSnapshot(store, workDir, [makeRoot("alpha")], "2020-01-02T00:00:00.000Z");

    expect(second.identity).toBe(first.identity);
  });

  it("nothing is persisted if a later insert in the same call fails", () => {
    const roots = [makeRoot("alpha")];
    // A root with a name too long for no real reason isn't a natural failure to
    // trigger, so instead assert the transaction contract directly: throwing
    // from inside leaves no rows behind.
    expect(() =>
      store.transaction(() => {
        beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");
        throw new Error("something after the snapshot failed");
      }),
    ).toThrow("something after the snapshot failed");

    expect(store.all("SELECT * FROM workspaces")).toEqual([]);
    expect(store.all("SELECT * FROM snapshots")).toEqual([]);
    expect(store.all("SELECT * FROM source_roots")).toEqual([]);
  });
});

describe("publishOrRefuse — clean source", () => {
  it("sets published_at when nothing has changed", () => {
    const roots = [makeRoot("alpha"), makeRoot("beta")];
    const handle = beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");

    publishOrRefuse(store, handle, roots, "2020-01-01T00:00:05.000Z");

    const row = store.get<{ published_at: string | null }>(
      "SELECT published_at FROM snapshots WHERE id = ?",
      [handle.snapshotId],
    );
    expect(row?.published_at).toBe("2020-01-01T00:00:05.000Z");
  });
});

describe("publishOrRefuse — drift", () => {
  it("refuses to publish when a root changed after it was captured", () => {
    const roots = [makeRoot("alpha"), makeRoot("beta")];
    const handle = beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");

    // Source moves after capture, before publish — the exact window this
    // check exists to close.
    write("alpha", "index.ts", "export const a = 999;\n");

    expect(() => publishOrRefuse(store, handle, roots)).toThrow(DriftDetectedError);
  });

  it("names the changed root in the error", () => {
    const roots = [makeRoot("alpha"), makeRoot("beta")];
    const handle = beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");

    write("beta", "index.ts", "export const b = 999;\n");

    try {
      publishOrRefuse(store, handle, roots);
      expect.unreachable("expected publishOrRefuse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriftDetectedError);
      expect((error as DriftDetectedError).changedRoots).toEqual(["beta"]);
    }
  });

  it("does not set published_at when refusing", () => {
    const roots = [makeRoot("alpha")];
    const handle = beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");
    write("alpha", "index.ts", "export const a = 999;\n");

    try {
      publishOrRefuse(store, handle, roots);
    } catch {
      // expected
    }

    const row = store.get<{ published_at: string | null }>(
      "SELECT published_at FROM snapshots WHERE id = ?",
      [handle.snapshotId],
    );
    expect(row?.published_at).toBeNull();
  });

  it("leaves target source untouched by the drift check itself", () => {
    // The drift check re-reads source to compare digests. It must not write
    // anything back, on either the clean or the refusing path.
    const roots = [makeRoot("alpha")];
    const handle = beginSnapshot(store, workDir, roots, "2020-01-01T00:00:00.000Z");
    write("alpha", "index.ts", "export const a = 999;\n");

    const before = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false })
      .contentDigest;

    try {
      publishOrRefuse(store, handle, roots);
    } catch {
      // expected — asserting the source is untouched regardless
    }

    const after = snapshotRoot({ name: "alpha", path: join(workDir, "alpha"), isGitRepo: false })
      .contentDigest;
    expect(after).toBe(before);
  });
});
