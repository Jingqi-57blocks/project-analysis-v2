import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveVariant } from "../support/targets/derive.js";

let workDir: string;
let sourceRoot: string;
let outputDir: string;

function write(base: string, relativePath: string, contents: string): void {
  const full = join(base, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-derive-"));
  sourceRoot = join(workDir, "source-root");
  outputDir = join(workDir, "derived", "variant");

  write(sourceRoot, "main.go", "package main\n");
  write(sourceRoot, "go.mod", "module example.com/thing\n");
  write(sourceRoot, "internal/handler.go", "package internal\n");
  write(sourceRoot, ".git/HEAD", "ref: refs/heads/main\n");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("deriveVariant", () => {
  it("copies source files into the output directory", () => {
    const result = deriveVariant({ sourceRoot, outputDir });

    expect(result.rebuilt).toBe(true);
    expect(readFileSync(join(outputDir, "main.go"), "utf8")).toBe("package main\n");
    expect(existsSync(join(outputDir, "internal", "handler.go"))).toBe(true);
  });

  it("never copies version-control internals, so a variant is always non-git", () => {
    deriveVariant({ sourceRoot, outputDir });
    expect(existsSync(join(outputDir, ".git"))).toBe(false);
  });

  it("keeps manifests by default", () => {
    const result = deriveVariant({ sourceRoot, outputDir });

    expect(existsSync(join(outputDir, "go.mod"))).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("removes manifests when asked, and reports what it removed", () => {
    const result = deriveVariant({ sourceRoot, outputDir, withoutManifest: true });

    expect(existsSync(join(outputDir, "go.mod"))).toBe(false);
    expect(existsSync(join(outputDir, "main.go"))).toBe(true);
    expect(result.removed).toEqual(["go.mod"]);
  });

  it("does nothing on a second run", () => {
    deriveVariant({ sourceRoot, outputDir });
    expect(deriveVariant({ sourceRoot, outputDir }).rebuilt).toBe(false);
  });

  it("rebuilds when the source changes", () => {
    deriveVariant({ sourceRoot, outputDir });
    write(sourceRoot, "extra.go", "package main\n");

    expect(deriveVariant({ sourceRoot, outputDir }).rebuilt).toBe(true);
    expect(existsSync(join(outputDir, "extra.go"))).toBe(true);
  });

  it("rebuilds when the manifest option changes", () => {
    deriveVariant({ sourceRoot, outputDir });
    const second = deriveVariant({ sourceRoot, outputDir, withoutManifest: true });

    expect(second.rebuilt).toBe(true);
    expect(existsSync(join(outputDir, "go.mod"))).toBe(false);
  });

  it("leaves the source root untouched", () => {
    deriveVariant({ sourceRoot, outputDir, withoutManifest: true, force: true });

    expect(existsSync(join(sourceRoot, "go.mod"))).toBe(true);
    expect(existsSync(join(sourceRoot, ".git", "HEAD"))).toBe(true);
    expect(readFileSync(join(sourceRoot, "main.go"), "utf8")).toBe("package main\n");
  });

  it("throws when the source root does not exist", () => {
    expect(() => deriveVariant({ sourceRoot: join(workDir, "absent"), outputDir })).toThrow(
      /Source root not found/,
    );
  });
});

describe("deriveVariant safety guards", () => {
  it("refuses to write inside the source root", () => {
    expect(() => deriveVariant({ sourceRoot, outputDir: join(sourceRoot, "out") })).toThrow(
      /overlaps the source root/,
    );
  });

  it("refuses to write to a parent of the source root", () => {
    expect(() => deriveVariant({ sourceRoot, outputDir: workDir })).toThrow(
      /overlaps the source root/,
    );
  });

  it("refuses to write to the source root itself", () => {
    expect(() => deriveVariant({ sourceRoot, outputDir: sourceRoot })).toThrow(
      /overlaps the source root/,
    );
  });

  it("refuses to delete a non-empty directory it did not create", () => {
    const foreign = join(workDir, "someone-elses-work");
    write(foreign, "important.txt", "do not delete\n");

    expect(() => deriveVariant({ sourceRoot, outputDir: foreign })).toThrow(
      /was not created by this tool/,
    );
    expect(readFileSync(join(foreign, "important.txt"), "utf8")).toBe("do not delete\n");
  });

  it("reuses an empty directory without complaint", () => {
    const empty = join(workDir, "empty");
    mkdirSync(empty, { recursive: true });

    expect(deriveVariant({ sourceRoot, outputDir: empty }).rebuilt).toBe(true);
  });
});
