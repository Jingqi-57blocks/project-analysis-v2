import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { runAnalyze, UnsafeDatabaseLocationError } from "../../engine/run/analyze.js";
import { DriftDetectedError } from "../../engine/snapshot/persist.js";
import { ProviderUnavailableError, type Provider } from "../../engine/providers/types.js";
import { codeIndexPresent } from "../../engine/kb/build.js";

let workDir: string;
let alphaPath: string;
let betaPath: string;
let dbPath: string;

function write(root: string, relativePath: string, contents: string): void {
  const full = join(workDir, root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function initRepo(root: string): void {
  const path = join(workDir, root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "initial"],
    { cwd: path },
  );
}

/**
 * A run with nothing to read.
 *
 * These tests are about the run's mechanics — snapshots, inventory, drift,
 * phase metrics — and the default reader set includes one that shells out to
 * an external indexer. Pinning the readers keeps what is being tested here
 * independent of whether that tool is installed.
 */
const NO_READERS = { structural: [], data: [], collectors: [] } as const;

function fakeProvider(
  id: string,
  result: "available" | "unavailable",
  onPreflight?: () => void,
): Provider {
  return {
    id,
    version: "1.0.0",
    capabilities: () => [],
    preflight: () => {
      onPreflight?.();
      return result === "available"
        ? { available: true, version: "1.0.0" }
        : { available: false, reason: `${id} missing` };
    },
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-analyze-"));
  write("alpha", "index.ts", "export const a = 1;\n");
  write("beta", "index.ts", "export const b = 2;\n");
  initRepo("beta");
  alphaPath = join(workDir, "alpha");
  betaPath = join(workDir, "beta");
  dbPath = join(workDir, "kb.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function openResultStore(): Store {
  return openStore(dbPath);
}

/** Symbols the run actually recorded, which is what an index either supplies or does not. */
function symbolCount(snapshotId: number): number {
  const store = openResultStore();
  try {
    return (
      store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM structural_records WHERE snapshot_id = ? AND kind = 'symbol'",
        [snapshotId],
      )?.n ?? 0
    );
  } finally {
    store.close();
  }
}

describe("runAnalyze — happy path", () => {
  it("analyzes both roots and publishes the snapshot", () => {
    const result = runAnalyze(
      { paths: [alphaPath, betaPath], dbPath, readers: NO_READERS },
      "2020-01-01T00:00:00.000Z",
    );

    expect(result.roots.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
    const alpha = result.roots.find((r) => r.name === "alpha")!;
    const beta = result.roots.find((r) => r.name === "beta")!;
    expect(alpha.vcs).toBe("none");
    expect(beta.vcs).toBe("git");
    expect(alpha.counts.analyzed).toBeGreaterThanOrEqual(1);
    expect(beta.counts.analyzed).toBeGreaterThanOrEqual(1);
    expect(result.providerReport.results).toEqual([]);

    const store = openResultStore();
    try {
      const row = store.get<{ published_at: string | null }>(
        "SELECT published_at FROM snapshots WHERE id = ?",
        [result.snapshotId],
      );
      expect(row?.published_at).toBe("2020-01-01T00:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("records one files row per analyzed/excluded/failed entry, tied to the right root", () => {
    const result = runAnalyze({ paths: [alphaPath, betaPath], dbPath, readers: NO_READERS });

    const store = openResultStore();
    try {
      const alphaRootId = store.get<{ id: number }>(
        "SELECT id FROM source_roots WHERE snapshot_id = ? AND name = 'alpha'",
        [result.snapshotId],
      )!.id;
      const files = store.all<{ rel_path: string; disposition: string }>(
        "SELECT rel_path, disposition FROM files WHERE source_root_id = ?",
        [alphaRootId],
      );
      expect(files.some((f) => f.rel_path === "index.ts" && f.disposition === "analyzed")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("persists phase_metrics for every phase, reconciling with the returned counts", () => {
    const result = runAnalyze({ paths: [alphaPath, betaPath], dbPath, readers: NO_READERS });

    const store = openResultStore();
    try {
      const rows = store.all<{ phase: string; items: number | null; bytes: number | null }>(
        "SELECT phase, items, bytes FROM phase_metrics WHERE snapshot_id = ? ORDER BY id",
        [result.snapshotId],
      );
      expect(rows.map((r) => r.phase)).toEqual([
        "select",
        "snapshot-capture",
        "begin-snapshot",
        "inventory",
        "preflight",
        "extract",
        "derive",
        "persist",
        "publish",
      ]);

      const inventoryRow = rows.find((r) => r.phase === "inventory")!;
      const totalDiscovered = result.roots.reduce((sum, r) => sum + r.counts.discovered, 0);
      expect(inventoryRow.items).toBe(totalDiscovered);

      const preflightRow = rows.find((r) => r.phase === "preflight")!;
      expect(preflightRow.items).toBe(0); // no providers registered

      const publishRow = rows.find((r) => r.phase === "publish")!;
      expect(publishRow.items).toBe(2); // two roots re-checked for drift
    } finally {
      store.close();
    }
  });

  it("writes one provider_checks row per registered provider", () => {
    const result = runAnalyze({
      paths: [alphaPath, betaPath],
      dbPath,
      readers: NO_READERS,
      providers: [fakeProvider("a", "available")],
    });

    const store = openResultStore();
    try {
      const rows = store.all<{ provider_id: string }>(
        "SELECT provider_id FROM provider_checks WHERE snapshot_id = ?",
        [result.snapshotId],
      );
      expect(rows).toEqual([{ provider_id: "a" }]);
    } finally {
      store.close();
    }
  });
});

describe("runAnalyze — knowledge-base location", () => {
  it("refuses a database path inside a root being analyzed", () => {
    expect(() =>
      runAnalyze({ paths: [alphaPath, betaPath], dbPath: join(alphaPath, "kb.sqlite") }),
    ).toThrow(UnsafeDatabaseLocationError);
  });

  it("refuses a nested path inside a root, not only a direct child", () => {
    expect(() =>
      runAnalyze({ paths: [alphaPath, betaPath], dbPath: join(alphaPath, "deep", "nested", "kb.sqlite") }),
    ).toThrow(UnsafeDatabaseLocationError);
  });

  it("names the offending root so the message is actionable", () => {
    try {
      runAnalyze({ paths: [alphaPath, betaPath], dbPath: join(betaPath, "kb.sqlite") });
      expect.unreachable("expected runAnalyze to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeDatabaseLocationError);
      expect((error as UnsafeDatabaseLocationError).rootName).toBe("beta");
    }
  });

  it("refuses before creating the database file at all", () => {
    const unsafePath = join(alphaPath, "kb.sqlite");
    expect(() => runAnalyze({ paths: [alphaPath], dbPath: unsafePath })).toThrow(
      UnsafeDatabaseLocationError,
    );
    expect(existsSync(unsafePath)).toBe(false);
  });

  it("allows a sibling path that merely shares a prefix with a root name", () => {
    // "alpha-output" starts with "alpha" as a string but is not inside it —
    // a prefix comparison rather than a path comparison would wrongly refuse.
    const siblingDb = join(workDir, "alpha-output", "kb.sqlite");
    expect(() => runAnalyze({ paths: [alphaPath], dbPath: siblingDb, readers: NO_READERS })).not.toThrow();
    expect(existsSync(siblingDb)).toBe(true);
  });

  it("allows the workspace directory that contains the roots", () => {
    expect(() => runAnalyze({ paths: [alphaPath, betaPath], dbPath, readers: NO_READERS })).not.toThrow();
  });
});

describe("runAnalyze — missing required provider", () => {
  it("throws ProviderUnavailableError and leaves the snapshot unpublished", () => {
    expect(() =>
      runAnalyze({
        paths: [alphaPath, betaPath],
        dbPath,
        providers: [fakeProvider("required-thing", "unavailable")],
        requiredProviderIds: ["required-thing"],
      }),
    ).toThrow(ProviderUnavailableError);

    const store = openResultStore();
    try {
      const row = store.get<{ published_at: string | null }>(
        "SELECT published_at FROM snapshots ORDER BY id DESC LIMIT 1",
      );
      expect(row?.published_at).toBeNull();
    } finally {
      store.close();
    }
  });

  it("does not disturb a previously published snapshot", () => {
    const first = runAnalyze({ paths: [alphaPath, betaPath], dbPath, readers: NO_READERS }, "2020-01-01T00:00:00.000Z");

    expect(() =>
      runAnalyze({
        paths: [alphaPath, betaPath],
        dbPath,
        providers: [fakeProvider("required-thing", "unavailable")],
        requiredProviderIds: ["required-thing"],
      }),
    ).toThrow(ProviderUnavailableError);

    const store = openResultStore();
    try {
      const row = store.get<{ published_at: string | null }>(
        "SELECT published_at FROM snapshots WHERE id = ?",
        [first.snapshotId],
      );
      expect(row?.published_at).toBe("2020-01-01T00:00:00.000Z");
    } finally {
      store.close();
    }
  });
});

describe("runAnalyze — drift between capture and publish", () => {
  it("refuses to publish when source moves after being captured, in the exact window a slow provider check widens", () => {
    const first = runAnalyze({ paths: [alphaPath, betaPath], dbPath, readers: NO_READERS }, "2020-01-01T00:00:00.000Z");

    const driftingProvider = fakeProvider("slow", "available", () => {
      write("alpha", "index.ts", "export const a = 999;\n");
    });

    expect(() =>
      runAnalyze({
        paths: [alphaPath, betaPath],
        dbPath,
        readers: NO_READERS,
        providers: [driftingProvider],
      }),
    ).toThrow(DriftDetectedError);

    const store = openResultStore();
    try {
      // The prior published snapshot is untouched.
      const priorRow = store.get<{ published_at: string | null }>(
        "SELECT published_at FROM snapshots WHERE id = ?",
        [first.snapshotId],
      );
      expect(priorRow?.published_at).toBe("2020-01-01T00:00:00.000Z");

      // The new, refused snapshot stays unpublished rather than disappearing.
      const refusedRow = store.get<{ published_at: string | null }>(
        "SELECT published_at FROM snapshots WHERE id != ? ORDER BY id DESC LIMIT 1",
        [first.snapshotId],
      );
      expect(refusedRow?.published_at).toBeNull();
    } finally {
      store.close();
    }
  });

  it("still records the failed run's phase timings, showing where its time went", () => {
    const first = runAnalyze({ paths: [alphaPath, betaPath], dbPath, readers: NO_READERS }, "2020-01-01T00:00:00.000Z");

    const driftingProvider = fakeProvider("slow", "available", () => {
      write("alpha", "index.ts", "export const a = 999;\n");
    });

    expect(() =>
      runAnalyze({
        paths: [alphaPath, betaPath],
        dbPath,
        readers: NO_READERS,
        providers: [driftingProvider],
      }),
    ).toThrow(DriftDetectedError);

    const store = openResultStore();
    try {
      const refusedId = store.get<{ id: number }>(
        "SELECT id FROM snapshots WHERE id != ? ORDER BY id DESC LIMIT 1",
        [first.snapshotId],
      )!.id;

      const phases = store
        .all<{ phase: string }>("SELECT phase FROM phase_metrics WHERE snapshot_id = ? ORDER BY id", [
          refusedId,
        ])
        .map((r) => r.phase);

      // Everything that completed is recorded; "publish" is absent because it
      // threw rather than finished — an honest record, not a fabricated one.
      expect(phases).toEqual([
        "select",
        "snapshot-capture",
        "begin-snapshot",
        "inventory",
        "preflight",
        "extract",
        "derive",
        "persist",
      ]);
    } finally {
      store.close();
    }
  });
});

describe("codeIndexPresent", () => {
  const shell = () => {
    // What a refused, crashed or killed run leaves: the directory, no store.
    mkdirSync(join(workDir, ".codegraph"), { recursive: true });
    writeFileSync(join(workDir, ".codegraph", "telemetry-queue.jsonl"), "");
  };
  const store = () => {
    mkdirSync(join(workDir, ".codegraph"), { recursive: true });
    writeFileSync(join(workDir, ".codegraph", "codegraph.db"), "");
  };

  it("does not count an empty index directory as an index", () => {
    // The directory is created before the indexer decides whether to index, and
    // ~/.codegraph is where the tool installs itself — so the directory answered
    // yes to both. Worse, a shell is self-perpetuating: seeing it, the adapter
    // chooses `index -q` over `init`, and that exits 0 having built nothing. The
    // run then reported an index, supplied no symbols, and recorded no failure.
    shell();
    expect(codeIndexPresent(workDir)).toBe(false);
  });

  it("counts one where the store is there", () => {
    store();
    expect(codeIndexPresent(workDir)).toBe(true);
  });

  it("counts nothing where the directory is absent", () => {
    expect(codeIndexPresent(workDir)).toBe(false);
    expect(codeIndexPresent(null)).toBe(false);
    expect(codeIndexPresent(undefined)).toBe(false);
  });
});

describe("where the code index goes", () => {
  it("says where it will write one, so nobody has to find it afterwards", () => {
    const result = runAnalyze({ paths: [alphaPath], dbPath, readers: NO_READERS });
    // With readers pinned there is no indexer, and the run says so rather
    // than leaving the question open.
    expect(result.codeIndexPath).toBeNull();
  });

  it("writes none when told not to, and records that as a gap", { timeout: 600_000 }, () => {
    const result = runAnalyze({ paths: [alphaPath], dbPath, noCodeIndex: true });
    expect(result.codeIndexPath).toBeNull();

    const store = openResultStore();
    try {
      const notes = store.all<{ payload: string }>(
        "SELECT payload FROM derived_records WHERE snapshot_id = ? AND kind = 'coverage-note'",
        [result.snapshotId],
      );
      // Refusing the write is supported, and what it costs is stated: on a
      // project whose frameworks the in-process readers do not cover, it is
      // the difference between a described system and an empty one.
      const note = notes
        .map((row) => JSON.parse(row.payload) as { subject: string; note: string })
        .find((entry) => entry.subject === "code-index");
      expect(note?.note).toContain("no code index was built");
    } finally {
      store.close();
    }
  });

  it("builds it in the directory holding the roots, and nowhere else", { timeout: 600_000 }, () => {
    // On disk, not in the report. The report agreeing with the plan is what
    // 57B-253 already had while the index itself went somewhere useless, so the
    // filesystem is the only witness worth asking.
    write("alpha", "thing.py", "def thing():\n    return 1\n");
    const result = runAnalyze({ paths: [alphaPath], dbPath });

    expect(result.codeIndexPath).toBe(workDir);
    expect(result.codeIndexPresent).toBe(true);
    expect(existsSync(join(workDir, ".codegraph"))).toBe(true);
    // The read-only guarantee: never inside the analyzed root.
    expect(existsSync(join(alphaPath, ".codegraph"))).toBe(false);
  });

  it("reads symbols the in-process readers cannot, when an index is built", { timeout: 600_000 }, () => {
    // Python deliberately: the declaration reader claims every language it can
    // parse, so a TypeScript fixture yields no CodeGraph symbols either way and
    // the comparison would prove nothing.
    write("alpha", "thing.py", "def thing():\n    return 1\n");

    const indexed = runAnalyze({ paths: [alphaPath], dbPath });
    const withIndex = symbolCount(indexed.snapshotId);

    rmSync(dbPath, { force: true });
    const skipped = runAnalyze({ paths: [alphaPath], dbPath, noCodeIndex: true });
    const withoutIndex = symbolCount(skipped.snapshotId);

    expect(withIndex).toBeGreaterThan(withoutIndex);
  });

  it("records the location in the knowledge base, not only in the terminal", { timeout: 600_000 }, () => {
    // A limitation visible only to whoever ran the command is one nobody
    // reading the report ever sees.
    const result = runAnalyze({ paths: [alphaPath], dbPath });

    const store = openResultStore();
    try {
      const notes = store
        .all<{ payload: string }>(
          "SELECT payload FROM derived_records WHERE snapshot_id = ? AND kind = 'coverage-note'",
          [result.snapshotId],
        )
        .map((note) => JSON.parse(note.payload) as { subject: string; note: string });
      const written = notes.find((note) => note.subject === "code-index");
      expect(written?.note).toContain(result.codeIndexPath!);
    } finally {
      store.close();
    }
  });
});
