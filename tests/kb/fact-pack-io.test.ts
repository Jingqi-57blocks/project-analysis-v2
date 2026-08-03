import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pruneFactPackBulk, writeFactPack, type FactPackIndex } from "../../engine/kb/fact-pack-io.js";
import type { FactPack } from "../../engine/kb/fact-pack.js";

const pack: FactPack = {
  snapshotIdentity: "run-1",
  scope: "project",
  moduleId: null,
  kbModuleId: null,
  requires: ["route", "condition", "entity"],
  rows: [
    { table: "structural_records", kind: "route", key: "r1", payload: {}, rootName: "svc", relPath: "a.go", startLine: 1, subjectKey: null },
    { table: "structural_records", kind: "condition", key: "c1", payload: {}, rootName: "svc", relPath: "a.go", startLine: 2, subjectKey: null },
    { table: "behavior_facts", kind: "condition", key: "c2", payload: {}, rootName: "svc", relPath: "a.go", startLine: 2, subjectKey: null },
  ],
  coverage: [
    { kind: "route", table: "structural_records", inSnapshot: 1, inScope: 1 },
    { kind: "condition", table: "structural_records", inSnapshot: 1, inScope: 1 },
    { kind: "condition", table: "behavior_facts", inSnapshot: 1, inScope: 1 },
  ],
  subjects: [{ type: "route", ref: "r1", factKey: "r1" }],
};

function write(): { dir: string; index: FactPackIndex } {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  return { dir, index: writeFactPack(pack, dir) };
}

describe("fact pack on disk", () => {
  it("writes one line-oriented file per kind", () => {
    const { dir, index } = write();
    expect(index.kinds.map((k) => k.kind)).toEqual(["condition", "route"]);
    const lines = readFileSync(join(dir, "kinds/condition.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).key).toBe("c1");
  });

  it("reports rows per table, never one total", () => {
    // Fourteen kinds are served by both raw tables, so one underlying fact
    // appears twice; a single number would read as twice as many facts.
    const { index } = write();
    const condition = index.kinds.find((k) => k.kind === "condition");
    expect(condition?.rowsByTable).toEqual({ structural_records: 1, behavior_facts: 1 });
  });

  it("keeps subjects out of the index", () => {
    const { dir, index } = write();
    expect(index.subjectCount).toBe(1);
    expect(index.subjectsFile).toBe("subjects.jsonl");
    expect(readFileSync(join(dir, "subjects.jsonl"), "utf8")).toContain('"ref":"r1"');
  });

  it("names the required kinds that produced no rows", () => {
    const { index } = write();
    expect(index.emptyKinds).toEqual(["entity"]);
  });

  it("carries the scope and snapshot identity the report must declare", () => {
    const { index } = write();
    expect(index.snapshotIdentity).toBe("run-1");
    expect(index.scope).toBe("project");
  });
});

describe("pruning a pack", () => {
  it("drops the rows and keeps the index", () => {
    // The rows are recomputable from the store; the index is what a later reader
    // needs to interpret the run's coverage statements.
    const { dir } = write();
    pruneFactPackBulk(dir);
    expect(existsSync(join(dir, "kinds"))).toBe(false);
    expect(existsSync(join(dir, "subjects.jsonl"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).kinds).toHaveLength(2);
  });

  it("is safe to call on a directory that was never written", () => {
    expect(() => pruneFactPackBulk(join(tmpdir(), "no-such-pack"))).not.toThrow();
  });
});
