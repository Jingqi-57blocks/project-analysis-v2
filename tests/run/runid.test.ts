import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isRunId, newRunId } from "../../engine/run/runid.js";
import { runAnalyze } from "../../engine/run/analyze.js";
import { getStatus } from "../../engine/run/status.js";
import { openStore } from "../../engine/store/open.js";

/**
 * Run identity is about the run, not about what was read. Pinning the readers
 * keeps these tests off the external indexer the default set includes.
 */
const NO_READERS = { structural: [], data: [], collectors: [] } as const;

let workDir: string;
let dbPath: string;

function write(root: string, relPath: string, contents: string): void {
  const full = join(workDir, root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-runid-"));
  write("alpha", "index.ts", "export const a = 1;\n");
  dbPath = join(workDir, "kb.sqlite");
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("newRunId", () => {
  it("is unique across runs starting in the same second", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRunId(new Date("2026-07-28T10:00:00Z"))));
    expect(ids.size).toBe(200);
  });

  it("sorts chronologically as a string", () => {
    const earlier = newRunId(new Date("2026-07-28T10:00:00Z"));
    const later = newRunId(new Date("2026-07-28T11:00:00Z"));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it("is recognizable as a run id", () => {
    expect(isRunId(newRunId())).toBe(true);
    expect(isRunId("not-a-run-id")).toBe(false);
  });
});

describe("runs of unchanged source", () => {
  it("share a content identity but get distinct run ids", () => {
    // This is the whole reason run ids exist: identity is a content digest, so
    // it cannot tell two analyses of the same unchanged project apart.
    const first = runAnalyze({ paths: [join(workDir, "alpha")], dbPath, readers: NO_READERS });
    const second = runAnalyze({ paths: [join(workDir, "alpha")], dbPath, readers: NO_READERS });

    expect(second.identity).toBe(first.identity);
    expect(second.runId).not.toBe(first.runId);
  });

  it("records both runs rather than overwriting the first", () => {
    const first = runAnalyze({ paths: [join(workDir, "alpha")], dbPath, readers: NO_READERS });
    const second = runAnalyze({ paths: [join(workDir, "alpha")], dbPath, readers: NO_READERS });

    const store = openStore(dbPath);
    try {
      const runs = store.all<{ run_id: string }>(
        "SELECT run_id FROM snapshots WHERE run_id IS NOT NULL ORDER BY id",
      );
      expect(runs.map((r) => r.run_id)).toEqual([first.runId, second.runId]);
    } finally {
      store.close();
    }
  });
});

describe("status by run", () => {
  it("reports a named earlier run rather than only the latest", () => {
    // An overview and a module report generated separately must be able to
    // name the same run, or they could describe two different analyses.
    const first = runAnalyze({ paths: [join(workDir, "alpha")], dbPath, readers: NO_READERS }, "2026-07-28T10:00:00.000Z");
    write("alpha", "index.ts", "export const a = 2;\n");
    const second = runAnalyze({ paths: [join(workDir, "alpha")], dbPath, readers: NO_READERS }, "2026-07-28T11:00:00.000Z");

    const store = openStore(dbPath);
    try {
      expect(getStatus(store, first.workspacePath).runId).toBe(second.runId);
      expect(getStatus(store, first.workspacePath, first.runId).snapshotId).toBe(first.snapshotId);
      expect(getStatus(store, first.workspacePath, first.runId).identity).toBe(first.identity);
    } finally {
      store.close();
    }
  });

  it("reports not-analyzed for a run id that does not exist", () => {
    const result = runAnalyze({ paths: [join(workDir, "alpha")], dbPath, readers: NO_READERS });

    const store = openStore(dbPath);
    try {
      expect(getStatus(store, result.workspacePath, "run-20200101T000000Z-abcdef").analyzed).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("the command surface", () => {
  it("prints the run id, so a later report can name it", { timeout: 600_000 }, () => {
    const output = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/analyze.ts", join(workDir, "alpha"), "--db", dbPath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(output).toMatch(/run run-\d{8}T\d{6}Z-[0-9a-f]{6}/);
  });
});
