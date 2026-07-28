import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkRoot } from "../../engine/inventory/walk.js";

let root: string;

function write(relativePath: string, contents = "x"): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pa-walk-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("walkRoot — accounting", () => {
  it("accounts for every item: 2 analyzed, 1 excluded directory, 0 failed", () => {
    write("a.ts", "export const a = 1;\n");
    write("b_test.ts", "test('x', () => {});\n");
    write("node_modules/dep/index.js", "module.exports = {};\n");

    const result = walkRoot(root);

    expect(result.analyzed.length).toBe(2);
    expect(result.excluded.length).toBe(1);
    expect(result.failed.length).toBe(0);
    expect(result.analyzed.map((f) => f.relPath).sort()).toEqual(["a.ts", "b_test.ts"]);
  });

  it("finds every file in a small realistic tree", () => {
    write("src/index.ts");
    write("src/util.ts");
    write("README.md");
    write("package.json", "{}");

    const result = walkRoot(root);
    expect(result.analyzed.map((f) => f.relPath).sort()).toEqual([
      "README.md",
      "package.json",
      join("src", "index.ts"),
      join("src", "util.ts"),
    ]);
  });
});

describe("walkRoot — dependency directories", () => {
  it("excludes a dependency directory as one row rather than walking its files", () => {
    write("node_modules/a/index.js");
    write("node_modules/a/package.json", "{}");
    write("node_modules/b/index.js");
    write("src/index.ts");

    const result = walkRoot(root);

    expect(result.excluded.map((e) => e.relPath)).toEqual(["node_modules"]);
    expect(result.analyzed.map((f) => f.relPath)).toEqual([join("src", "index.ts")]);
  });

  it("does not descend into node_modules even when it contains many files", () => {
    for (let i = 0; i < 50; i++) write(`node_modules/pkg-${i}/index.js`);

    const result = walkRoot(root);

    expect(result.excluded.length).toBe(1);
    expect(result.analyzed.length).toBe(0);
  });

  it("sums the excluded directory's size without reading file contents", () => {
    write("vendor/lib.go", "aaaaaaaaaa"); // 10 bytes
    write("vendor/nested/other.go", "bb"); // 2 bytes

    const result = walkRoot(root);
    expect(result.excluded[0]?.sizeBytes).toBe(12);
  });

  it("gives every excluded entry a non-empty reason", () => {
    write("node_modules/a/index.js");
    const result = walkRoot(root);
    expect(result.excluded[0]?.reason.length).toBeGreaterThan(0);
  });

  it("walks a directory that merely looks build-related but is not a package-manager directory", () => {
    // The real finding this design is built around: wcp-auth/build/ contains
    // only a Dockerfile, not build output. `build` must be walked, not
    // bulk-excluded, or a real config file goes missing.
    write("build/Dockerfile", "FROM node:22\n");

    const result = walkRoot(root);

    expect(result.excluded).toEqual([]);
    expect(result.analyzed.map((f) => f.relPath)).toEqual([join("build", "Dockerfile")]);
    expect(result.analyzed[0]?.classification).toBe("configuration");
  });
});

describe("walkRoot — version control and noise", () => {
  it("excludes .git as a subtree with its own reason, distinct from dependency directories", () => {
    write(".git/HEAD", "ref: refs/heads/main\n");
    write(".git/objects/aa/bbccddee", "binary-ish content");
    write("node_modules/dep/index.js");
    write("src/index.ts");

    const result = walkRoot(root);

    // .git is excluded, but not silently the way digest.ts's IGNORED_ENTRIES
    // would skip it — it has its own row, with its own reason, distinguishable
    // from why node_modules was excluded.
    const gitEntry = result.excluded.find((e) => e.relPath === ".git");
    const depEntry = result.excluded.find((e) => e.relPath === "node_modules");
    expect(gitEntry?.reason).toContain("version-control");
    expect(depEntry?.reason).toContain("dependency-manager");
    expect(gitEntry?.reason).not.toBe(depEntry?.reason);

    expect(result.analyzed.map((f) => f.relPath)).toEqual([join("src", "index.ts")]);
  });

  it("excludes .DS_Store individually with a reason, never silently", () => {
    write(".DS_Store", "\x00\x01binary junk");
    write("src/index.ts");

    const result = walkRoot(root);

    const dsStore = result.excluded.find((e) => e.relPath === ".DS_Store");
    expect(dsStore).toBeDefined();
    expect(dsStore?.reason.length).toBeGreaterThan(0);
    expect(result.analyzed.map((f) => f.relPath)).toEqual([join("src", "index.ts")]);
  });
});

describe("walkRoot — classification", () => {
  it("classifies a file that peeks as generated when path/extension evidence is absent", () => {
    write("gen/output.gen", "// GENERATED BY THE COMMAND ABOVE; DO NOT EDIT\npackage gen\n");
    const result = walkRoot(root);
    const file = result.analyzed.find((f) => f.relPath === join("gen", "output.gen"));
    expect(file?.classification).toBe("generated");
  });

  it("classifies a generated file as generated even though its extension says source", () => {
    // The exact bug caught against a real target: docs.go is a .go file (a
    // source extension) whose content marks it generated. "source" must be
    // provisional, overridable by the content peek — not the final word.
    write("docs/docs.go", "// GENERATED BY THE COMMAND ABOVE; DO NOT EDIT\n\npackage docs\n");
    const result = walkRoot(root);
    const file = result.analyzed.find((f) => f.relPath === join("docs", "docs.go"));
    expect(file?.classification).toBe("generated");
  });

  it("still classifies an ordinary source file as source when it has no generated marker", () => {
    write("src/index.ts", "export const a = 1;\n");
    const result = walkRoot(root);
    expect(result.analyzed.find((f) => f.relPath === join("src", "index.ts"))?.classification).toBe(
      "source",
    );
  });

  it("does not peek generated-marker content for a test file — the test classification is final", () => {
    // A file matching a strong, specific convention (test naming) is trusted
    // without a content peek, even if it happens to contain generated-looking
    // text — that combination isn't meaningful enough to override it.
    write("src/foo_test.go", "// GENERATED BY THE COMMAND ABOVE; DO NOT EDIT\npackage src\n");
    const result = walkRoot(root);
    expect(result.analyzed.find((f) => f.relPath === join("src", "foo_test.go"))?.classification).toBe(
      "test",
    );
  });

  it("classifies weak-evidence files as unknown rather than guessing", () => {
    write("LICENSE", "MIT License\n...\n");
    const result = walkRoot(root);
    expect(result.analyzed.find((f) => f.relPath === "LICENSE")?.classification).toBe("unknown");
  });
});

describe("walkRoot — failures", () => {
  it("records an unreadable file as failed with a reason, not silently dropped", () => {
    write("locked.ts", "export const a = 1;\n");
    chmodSync(join(root, "locked.ts"), 0o000);

    try {
      const result = walkRoot(root);
      // On some CI environments the process may have permission to read
      // regardless of mode (e.g. running as root); only assert the failure
      // path when it actually occurred, but always assert the file was not
      // silently omitted from either list.
      const seen = [...result.analyzed.map((f) => f.relPath), ...result.failed.map((f) => f.relPath)];
      expect(seen).toContain("locked.ts");
      const failedEntry = result.failed.find((f) => f.relPath === "locked.ts");
      if (failedEntry) expect(failedEntry.reason.length).toBeGreaterThan(0);
    } finally {
      chmodSync(join(root, "locked.ts"), 0o644);
    }
  });

  it("records an unreadable directory as failed rather than aborting the whole walk", () => {
    write("ok/index.ts");
    mkdirSync(join(root, "locked-dir"));
    chmodSync(join(root, "locked-dir"), 0o000);

    try {
      const result = walkRoot(root);
      expect(result.analyzed.map((f) => f.relPath)).toContain(join("ok", "index.ts"));
      const failedEntry = result.failed.find((f) => f.relPath === "locked-dir");
      if (failedEntry) expect(failedEntry.reason.length).toBeGreaterThan(0);
    } finally {
      chmodSync(join(root, "locked-dir"), 0o755);
    }
  });
});

describe("walkRoot — read-only", () => {
  it("never writes into the walked root", () => {
    write("a.ts");
    write("b.ts");

    walkRoot(root);

    // A cheap, meaningful check: exactly the two files exist, nothing extra
    // was created by walking.
    expect(readdirSync(root).sort()).toEqual(["a.ts", "b.ts"]);
  });
});
