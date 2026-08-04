import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CODE_INDEX_DIRECTORY,
  codeIndexDirName,
  isAnalysisArtifactDirectory,
} from "../../engine/artifacts.js";
import { codeIndexDbPath } from "../../engine/providers/codegraph/batchdb.js";
import { isIgnoredEntry } from "../../engine/targets/digest.js";

/**
 * CodeGraph renames its index directory when `CODEGRAPH_DIR` is set — two
 * environments sharing one working tree must not share one index. This tool
 * hard-coded the default in seven places, so on exactly those machines it
 * looked for a database that was not there, and digested the index it had just
 * written as though it were project source.
 */
afterEach(() => {
  delete process.env["CODEGRAPH_DIR"];
});

describe("resolving the index directory", () => {
  it("is the default when nothing overrides it", () => {
    expect(codeIndexDirName()).toBe(DEFAULT_CODE_INDEX_DIRECTORY);
  });

  it("follows the override", () => {
    process.env["CODEGRAPH_DIR"] = ".codegraph-win";
    expect(codeIndexDirName()).toBe(".codegraph-win");
    expect(codeIndexDbPath("/idx")).toBe("/idx/.codegraph-win/codegraph.db");
  });

  it("reads it live, so a value set after load still applies", () => {
    expect(codeIndexDirName()).toBe(DEFAULT_CODE_INDEX_DIRECTORY);
    process.env["CODEGRAPH_DIR"] = ".codegraph-wsl";
    expect(codeIndexDirName()).toBe(".codegraph-wsl");
  });

  it.each([".", "..", "a/b", "a\\b", "/abs", ""])(
    "ignores %s, exactly as CodeGraph does",
    (value) => {
      process.env["CODEGRAPH_DIR"] = value;
      expect(codeIndexDirName()).toBe(DEFAULT_CODE_INDEX_DIRECTORY);
    },
  );
});

describe("keeping an index out of the source it describes", () => {
  it("excludes the active override from digests and inventory", () => {
    process.env["CODEGRAPH_DIR"] = ".codegraph-win";

    expect(isAnalysisArtifactDirectory(".codegraph-win")).toBe(true);
    expect(isIgnoredEntry(".codegraph-win")).toBe(true);
  });

  it("excludes the default and any sibling index, whichever environment wrote it", () => {
    for (const name of [".codegraph", ".codegraph-win", ".codegraph-wsl"]) {
      expect(isAnalysisArtifactDirectory(name), name).toBe(true);
    }
  });

  it("leaves ordinary project directories alone", () => {
    for (const name of ["src", "internal", "codegraph", ".github"]) {
      expect(isAnalysisArtifactDirectory(name), name).toBe(false);
    }
  });
});
