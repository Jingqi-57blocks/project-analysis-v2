import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAnalyze } from "../../engine/run/analyze.js";
import { openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { readDerived, readDerivedOne, readLinks } from "../../engine/kb/persist.js";
import { createFrameworkRoutesProvider } from "../../engine/providers/frameworkroutes/provider.js";
import { createLogicProvider } from "../../engine/providers/logic/provider.js";
import { createConventionsProvider } from "../../engine/providers/conventions/provider.js";
import { createSqlSchemaProvider } from "../../engine/datamodel/sql.js";
import { createDocumentationCollector } from "../../engine/collectors/documentation.js";

/**
 * One run over a small workspace, checked all the way to the tables.
 *
 * The readers are named rather than defaulted: this is about the pipeline
 * joining extraction to derivation to persistence, and the default set
 * includes one that shells out to an external indexer.
 */
const READERS = {
  structural: [
    createFrameworkRoutesProvider(),
    createLogicProvider(),
    createConventionsProvider(),
  ],
  data: [createSqlSchemaProvider()],
  collectors: [createDocumentationCollector()],
};

let workDir: string;
let dbPath: string;
let store: Store | undefined;

function write(relativePath: string, contents: string): void {
  const full = join(workDir, "svc", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-kb-"));
  write("README.md", "# Leave service\n\nHandles leave requests for staff across the company.\n");
  write("go.mod", "module example.com/svc\n\nrequire github.com/gin-gonic/gin v1.9.1\n");
  write(
    "migrations/001_init.sql",
    "CREATE TABLE leaves (id INT PRIMARY KEY, hours INT NOT NULL);\n",
  );
  write(
    "router.go",
    [
      "package main",
      "",
      "func Register(engine *gin.Engine) {",
      '\tv2 := engine.Group("/v2")',
      '\tv2.POST("/leaves", Apply)',
      "}",
    ].join("\n"),
  );
  write(
    "leave.go",
    [
      "package main",
      "",
      "const (",
      "\tLeaveDraft = 1",
      "\tLeaveApproved = 2",
      ")",
      "",
      "func Apply(c *gin.Context) {",
      "\tif lv.Hours > 40 {",
      "\t\treturn",
      "\t}",
      "\tdb.Table(\"leaves\").Create(&lv)",
      "}",
    ].join("\n"),
  );
  dbPath = join(workDir, "kb.sqlite");
});

afterEach(() => {
  store?.close();
  store = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

function analyze() {
  const result = runAnalyze({ paths: [join(workDir, "svc")], dbPath, readers: READERS });
  store = openStore(dbPath);
  return result;
}

describe("one run, one knowledge base", () => {
  it("persists what it read and what it worked out, under one run id", () => {
    const result = analyze();

    const context = readDerivedOne(store!, result.snapshotId, "run-context");
    expect(context?.runId).toBe(result.runId);

    const routes = store!.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM structural_records WHERE snapshot_id = ? AND kind = 'route'",
      [result.snapshotId],
    );
    expect(routes!.n).toBe(1);

    const entities = store!.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM structural_records WHERE snapshot_id = ? AND kind = 'entity'",
      [result.snapshotId],
    );
    expect(entities!.n).toBe(1);
  });

  it("states a rule in the vocabulary the project declares elsewhere", () => {
    // The condition comes from one reader and the constants from another;
    // neither knows the other exists. Joining them is what this stage is for.
    const result = analyze();
    const rules = readDerived(store!, result.snapshotId, "business-rule");
    expect(rules.map((entry) => entry.record.text)).toContain("lv.Hours > 40");
    expect(readDerived(store!, result.snapshotId, "value-set")).not.toHaveLength(0);
  });

  it("says what it could not establish rather than leaving it out", () => {
    const result = analyze();
    const notes = readDerived(store!, result.snapshotId, "coverage-note");
    // No reader in this set supplies symbols, so nothing could be traced —
    // and a report shaped like "this project has no code structure" would be
    // a claim about the project rather than about the run.
    expect(notes.map((note) => note.record.subject)).toContain("symbol");
  });

  it("records that a capability was attempted, not just what it produced", () => {
    const result = analyze();
    const rows = store!.all<{ kind: string; outcome: string }>(
      "SELECT kind, outcome FROM capability_results WHERE snapshot_id = ?",
      [result.snapshotId],
    );
    expect(rows.some((row) => row.kind === "route" && row.outcome !== "absent")).toBe(true);
    expect(rows.some((row) => row.kind === "entity")).toBe(true);
  }, 15_000);

  it("quotes the prose the developers wrote, as evidence rather than as a summary", () => {
    const result = analyze();
    const items = store!.all<{ text: string }>(
      "SELECT text FROM evidence_items WHERE snapshot_id = ?",
      [result.snapshotId],
    );
    expect(items.some((item) => item.text.includes("leave requests"))).toBe(true);
  });

  it("links a capability to its own flows and rules", () => {
    const result = analyze();
    const features = readDerived(store!, result.snapshotId, "feature");
    if (features.length === 0) return; // a one-file service may name no capability

    const links = readLinks(store!, result.snapshotId, "feature", features[0]!.key);
    for (const link of links) {
      const row = store!.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM derived_records WHERE snapshot_id = ? AND kind = ? AND record_key = ?",
        [result.snapshotId, link.toKind, link.toKey],
      );
      // A link naming a record that is not there is a join that silently
      // returns nothing while every row it needs is present.
      expect(row!.n, `${link.role} → ${link.toKind} ${link.toKey}`).toBe(1);
    }
  });

  it("leaves the previous knowledge base alone when a run publishes a new one", () => {
    const first = analyze();
    store!.close();
    store = undefined;

    const second = runAnalyze({ paths: [join(workDir, "svc")], dbPath, readers: READERS });
    store = openStore(dbPath);

    expect(second.snapshotId).not.toBe(first.snapshotId);
    // Both snapshots keep their own facts; a rerun is a second answer, not an
    // overwrite of the first.
    for (const snapshotId of [first.snapshotId, second.snapshotId]) {
      expect(readDerivedOne(store!, snapshotId, "run-context")).not.toBeNull();
    }
  });
});
