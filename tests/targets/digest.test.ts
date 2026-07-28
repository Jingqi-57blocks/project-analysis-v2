import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestDirectory, listFiles } from "../../engine/targets/digest.js";

let dir: string;

function write(relativePath: string, contents: string): void {
  const full = join(dir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pa-digest-"));
  write("a.ts", "export const a = 1;\n");
  write("nested/b.ts", "export const b = 2;\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listFiles", () => {
  it("returns relative paths in sorted order", () => {
    expect(listFiles(dir)).toEqual(["a.ts", join("nested", "b.ts")]);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(listFiles(join(dir, "absent"))).toEqual([]);
  });
});

describe("digestDirectory", () => {
  it("is stable across calls on unchanged content", () => {
    expect(digestDirectory(dir)).toBe(digestDirectory(dir));
  });

  it("changes when a file's contents change", () => {
    const before = digestDirectory(dir);
    write("a.ts", "export const a = 99;\n");
    expect(digestDirectory(dir)).not.toBe(before);
  });

  it("changes when a file is renamed but its contents are not", () => {
    const before = digestDirectory(dir);
    write("renamed.ts", "export const a = 1;\n");
    rmSync(join(dir, "a.ts"));
    expect(digestDirectory(dir)).not.toBe(before);
  });

  it("changes when a file is added", () => {
    const before = digestDirectory(dir);
    write("c.ts", "export const c = 3;\n");
    expect(digestDirectory(dir)).not.toBe(before);
  });

  it("changes when a file is deleted", () => {
    const before = digestDirectory(dir);
    rmSync(join(dir, "nested", "b.ts"));
    expect(digestDirectory(dir)).not.toBe(before);
  });

  it("ignores version-control internals and installed dependencies", () => {
    const before = digestDirectory(dir);
    write(join(".git", "HEAD"), "ref: refs/heads/main\n");
    write(join("node_modules", "dep", "index.js"), "module.exports = {};\n");
    expect(digestDirectory(dir)).toBe(before);
  });
});
