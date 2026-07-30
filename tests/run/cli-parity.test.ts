import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { runAnalyze } from "../../engine/run/analyze.js";

/**
 * The command surface is meant to be a thin shell — no analysis logic of its
 * own. That is only true if a direct library call and a command invocation
 * leave the same knowledge base behind, so this compares the persisted rows
 * rather than the printed text: stdout formatting is a presentation choice,
 * the database is the actual result.
 */

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

let workDir: string;

function write(root: string, relativePath: string, contents: string): void {
  const full = join(workDir, root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

interface ComparableRoot {
  readonly name: string;
  readonly content_digest: string;
  readonly vcs: string | null;
  readonly files: readonly { readonly rel_path: string; readonly disposition: string; readonly classification: string | null }[];
}

/** The parts of a knowledge base that must match. Row ids and timestamps are run-specific by design. */
function comparableState(dbPath: string, workspacePath: string): readonly ComparableRoot[] {
  const store: Store = openStore(dbPath);
  try {
    const snapshot = store.get<{ id: number }>(
      `SELECT s.id FROM snapshots s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE w.path = ? AND s.published_at IS NOT NULL
       ORDER BY s.published_at DESC LIMIT 1`,
      [workspacePath],
    );
    expect(snapshot, `no published snapshot for ${workspacePath} in ${dbPath}`).toBeDefined();

    const roots = store.all<{ id: number; name: string; content_digest: string; vcs: string | null }>(
      "SELECT id, name, content_digest, vcs FROM source_roots WHERE snapshot_id = ? ORDER BY name",
      [snapshot!.id],
    );

    return roots.map((root) => ({
      name: root.name,
      content_digest: root.content_digest,
      vcs: root.vcs,
      files: store.all<{ rel_path: string; disposition: string; classification: string | null }>(
        `SELECT rel_path, disposition, classification FROM files
         WHERE source_root_id = ? ORDER BY rel_path`,
        [root.id],
      ),
    }));
  } finally {
    store.close();
  }
}

function runScript(script: string, args: readonly string[]): string {
  return execFileSync("pnpm", ["exec", "tsx", join("scripts", script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-cli-parity-"));
  write("alpha", "index.ts", "export const a = 1;\n");
  write("alpha", "README.md", "# alpha\n");
  write("beta", "main.go", "package main\n");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("library and command paths", () => {
  it("leave identical knowledge-base state behind", { timeout: 600_000 }, () => {
    const libraryDb = join(workDir, "library.sqlite");
    const commandDb = join(workDir, "command.sqlite");

    const libraryResult = runAnalyze({ paths: [join(workDir, "alpha"), join(workDir, "beta")], dbPath: libraryDb });
    runScript("analyze.ts", [join(workDir, "alpha"), join(workDir, "beta"), "--db", commandDb]);

    expect(comparableState(commandDb, libraryResult.workspacePath)).toEqual(
      comparableState(libraryDb, libraryResult.workspacePath),
    );
  });

  it("agree when a root is excluded by flag", { timeout: 600_000 }, () => {
    const libraryDb = join(workDir, "library.sqlite");
    const commandDb = join(workDir, "command.sqlite");

    const libraryResult = runAnalyze({
      paths: [join(workDir, "alpha"), join(workDir, "beta")],
      exclude: ["beta"],
      dbPath: libraryDb,
    });
    runScript("analyze.ts", [
      join(workDir, "alpha"),
      join(workDir, "beta"),
      "--exclude",
      "beta",
      "--db",
      commandDb,
    ]);

    const fromCommand = comparableState(commandDb, libraryResult.workspacePath);
    expect(fromCommand.map((r) => r.name)).toEqual(["alpha"]);
    expect(fromCommand).toEqual(comparableState(libraryDb, libraryResult.workspacePath));
  });
});

describe("status command", () => {
  it("reports a workspace the analyze command just wrote", { timeout: 600_000 }, () => {
    const dbPath = join(workDir, "kb.sqlite");
    const result = runAnalyze({ paths: [join(workDir, "alpha"), join(workDir, "beta")], dbPath });

    const output = runScript("status.ts", ["--workspace", result.workspacePath, "--db", dbPath]);

    expect(output).toContain(result.workspacePath);
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    expect(output).toContain("analyzed=");
  });

  it("says a never-analyzed workspace was never analyzed, rather than failing", { timeout: 600_000 }, () => {
    const dbPath = join(workDir, "kb.sqlite");
    runAnalyze({ paths: [join(workDir, "alpha")], dbPath });

    const output = runScript("status.ts", ["--workspace", join(workDir, "nowhere"), "--db", dbPath]);
    expect(output).toContain("never analyzed");
  });
});

describe("unrecognised options", () => {
  /** The command's exit is what matters here, so failures are caught rather than thrown. */
  function failure(args: readonly string[]): string {
    try {
      runScript("analyze.ts", args);
      return "";
    } catch (error) {
      const shape = error as { stderr?: string; stdout?: string; message?: string };
      return `${shape.stderr ?? ""}${shape.stdout ?? ""}${shape.message ?? ""}`;
    }
  }

  it("refuses an unknown flag rather than analyzing its value as a root", () => {
    // Ignoring a flag does not stop at the flag: its value is not skipped
    // either, so the next token becomes a path. Removing --index-root made this
    // concrete — `--index-root /tmp/x` analyzed /tmp/x and reported two roots
    // where one was asked for.
    const output = failure([
      join(workDir, "alpha"),
      "--index-root",
      join(workDir, "beta"),
      "--db",
      join(workDir, "kb.sqlite"),
      "--no-code-index",
    ]);

    expect(output).toContain("Unknown option --index-root");
    expect(output).toContain("has been removed");
  });

  it("names a mistyped flag instead of silently dropping it", () => {
    const output = failure([
      join(workDir, "alpha"),
      "--no-cod-index",
      "--db",
      join(workDir, "kb.sqlite"),
    ]);

    expect(output).toContain("Unknown option --no-cod-index");
  });

  it("still accepts the separator pnpm forwards, and the flags that exist", () => {
    const output = runScript("analyze.ts", [
      "--",
      join(workDir, "alpha"),
      "--db",
      join(workDir, "kb.sqlite"),
      "--no-code-index",
    ]);

    expect(output).toContain("alpha:");
    expect(output).not.toContain("beta:");
  });
});
