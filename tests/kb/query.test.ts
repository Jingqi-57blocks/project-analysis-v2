import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { runAnalyze } from "../../engine/run/analyze.js";
import { openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import {
  AmbiguousWorkspaceError,
  openKnowledgeBase,
  SnapshotNotFoundError,
  type KnowledgeBase,
} from "../../engine/kb/query.js";
import { buildExport } from "../../engine/kb/export.js";
import { createFrameworkRoutesProvider } from "../../engine/providers/frameworkroutes/provider.js";
import { createLogicProvider } from "../../engine/providers/logic/provider.js";
import { createConventionsProvider } from "../../engine/providers/conventions/provider.js";
import { createSqlSchemaProvider } from "../../engine/datamodel/sql.js";
import { createDataUsageProvider } from "../../engine/datamodel/usage.js";
import { createDocumentationCollector } from "../../engine/collectors/documentation.js";

const READERS = {
  structural: [
    createFrameworkRoutesProvider(),
    createLogicProvider(),
    createConventionsProvider(),
    createDataUsageProvider(),
  ],
  data: [createSqlSchemaProvider()],
  collectors: [createDocumentationCollector()],
};

let workDir: string;
let store: Store;
let kb: KnowledgeBase;
let runId: string;

function write(relativePath: string, contents: string): void {
  const full = join(workDir, "svc", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-query-"));
  write("README.md", "# Leave service\n\nHandles leave requests for staff across the company.\n");
  write("go.mod", "module example.com/svc\n\nrequire github.com/gin-gonic/gin v1.9.1\n");
  write(
    "migrations/001_init.sql",
    [
      "CREATE TABLE leaves (id INT PRIMARY KEY, hours INT NOT NULL);",
      "CREATE TABLE leave_details (id INT PRIMARY KEY, leave_id INT NOT NULL);",
    ].join("\n"),
  );
  write(
    "router.go",
    [
      "package main",
      "",
      "func Register(engine *gin.Engine) {",
      '\tv2 := engine.Group("/v2")',
      '\tv2.POST("/leaves", Apply)',
      '\tv2.GET("/leaves", List)',
      "}",
    ].join("\n"),
  );
  write(
    "leave.go",
    [
      "package main",
      "",
      "const (",
      "\tLeaveStatusDraft = 1",
      "\tLeaveStatusApproved = 2",
      ")",
      "",
      "func Apply(c *gin.Context) {",
      "\tif lv.Hours > 40 {",
      "\t\treturn",
      "\t}",
      '\tdb.Table("leaves").Create(&lv)',
      "}",
    ].join("\n"),
  );

  // A browser application declaring screens: two named for leave, one not.
  write(
    "package.json",
    JSON.stringify({ name: "svc-ui", dependencies: { "react-router-dom": "^6.0.0" } }),
  );
  write(
    "ui/src/App.tsx",
    [
      'import { Route, Routes } from "react-router-dom";',
      "",
      "export function App() {",
      "  return (",
      "    <Routes>",
      '      <Route path="/my/leave/create" element={<CreateLeave />} />',
      '      <Route path="/manage/approval/leave/list" element={<LeaveList />} />',
      '      <Route path="/manage/billing" element={<Billing />} />',
      "    </Routes>",
      "  );",
      "}",
    ].join("\n"),
  );

  // Outside every capability's files: a decision that must not be scoped
  // into one.
  write(
    "unrelated/audit.go",
    [
      "package audit",
      "",
      "func Sweep(kind int) string {",
      "\tswitch kind {",
      "\tcase 1:",
      "\t\treturn \"a\"",
      "\tcase 2:",
      "\t\treturn \"b\"",
      "\tdefault:",
      "\t\treturn \"c\"",
      "\t}",
      "}",
    ].join("\n"),
  );

  const dbPath = join(workDir, "kb.sqlite");
  const result = runAnalyze({ paths: [join(workDir, "svc")], dbPath, readers: READERS });
  runId = result.runId;
  store = openStore(dbPath);
  kb = openKnowledgeBase(store);
});

afterAll(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("choosing a snapshot", () => {
  it("reads the latest published run when none is named", () => {
    expect(kb.snapshot.runId).toBe(runId);
  });

  it("reads the run it was given", () => {
    expect(openKnowledgeBase(store, runId).snapshot.runId).toBe(runId);
  });

  it("refuses a run that does not exist rather than falling back to another", () => {
    // Falling back would answer questions about a different analysis while
    // looking like it answered about the one asked for.
    expect(() => openKnowledgeBase(store, "run-20200101T000000Z-abcdef")).toThrow(
      SnapshotNotFoundError,
    );
  });

  it("says nothing has been analyzed rather than throwing something opaque", () => {
    const empty = openStore(join(workDir, "empty.sqlite"));
    try {
      expect(() => openKnowledgeBase(empty)).toThrow(/Run `analyze` first/);
    } finally {
      empty.close();
    }
  });
});

describe("asking the knowledge base questions", () => {
  it("answers what this run was", () => {
    const context = kb.runContext();
    expect(context?.runId).toBe(runId);
    expect(context?.description).toContain("leave requests");
  });

  it("separates what the project serves from what it shows", () => {
    // An indexer reports both as routes. Listing them together would have
    // something rebuilding this project create an endpoint per screen.
    const served = kb.endpoints().map((route) => route.path);
    const shown = kb.screens().map((route) => route.path);
    expect(served.length).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(0);
    expect(served).not.toContain("/my/leave/create");
    expect(shown).not.toContain("/v2/leaves");
  });

  it("returns a table with its columns rather than four lists to join", () => {
    const model = kb.entityModel("leaves");
    expect(model?.fields.map((field) => field.name).sort()).toEqual(["hours", "id"]);
  });

  it("says whether anything looked, so an empty list can be read correctly", () => {
    const looked = kb.coverageFor("entity");
    expect(looked.attempted).toBe(true);

    // No reader in this set supplies test relations. "None" here is about the
    // run, not about the project, and the caller can tell.
    const nobodyLooked = kb.coverageFor("test-relation");
    expect(nobodyLooked.attempted).toBe(false);
  });

  it("hands back the rules as stated, with what explained them", () => {
    const rules = kb.businessRules();
    const hours = rules.find((rule) => rule.text.includes("40"));
    expect(hours?.guarded).toBe("rejects");
  });

  it("finds the vocabulary that explains a subject", () => {
    const set = kb.valueSetExplaining("lv.LeaveStatus");
    expect(set?.members.map((member) => member.name)).toContain("LeaveStatusApproved");
  });

  it("says what it could not establish", () => {
    expect(kb.coverageNotes().length).toBeGreaterThan(0);
  });

  it("returns nothing rather than guessing for a capability that does not exist", () => {
    expect(kb.featureDetail("feat_nonexistent")).toBeNull();
    expect(kb.moduleDetail("mod_nonexistent")).toBeNull();
    expect(kb.entityModel("nonexistent")).toBeNull();
  });
});

describe("the export", () => {
  it("is byte-identical across two runs over unchanged source", () => {
    // Exporting one snapshot twice only proves the key order is stable. The
    // property that matters is that a second analysis of unchanged code
    // produces the same document, so a diff means the code changed.
    const secondDb = join(workDir, "second.sqlite");
    runAnalyze({ paths: [join(workDir, "svc")], dbPath: secondDb, readers: READERS });
    const second = openStore(secondDb);
    try {
      // Only the two fields that are meant to differ. Feature and module ids
      // are derived from content and must match, so they stay in.
      const drop = (json: string): string =>
        json
          .replaceAll(/"run-\d{8}T\d{6}Z-[0-9a-f]+"/g, '"run"')
          .replaceAll(/"generatedAt":\s*"[^"]*"/g, '"generatedAt":""');
      expect(drop(JSON.stringify(buildExport(openKnowledgeBase(second))))).toBe(
        drop(JSON.stringify(buildExport(kb))),
      );
    } finally {
      second.close();
    }
  });

  it("carries the run identity, so a claim can be traced to an analysis", () => {
    const exported = buildExport(kb) as { run: { id: string; identity: string } };
    expect(exported.run.id).toBe(runId);
    expect(exported.run.identity).toHaveLength(64);
  });

  it("states data-model coverage beside the data model", () => {
    const exported = buildExport(kb) as { dataModel: { coverage: { attempted: boolean } } };
    expect(exported.dataModel.coverage.attempted).toBe(true);
  });

  it("needs no access to the project it describes", () => {
    // The source is gone from this handle's point of view; the export is a
    // read of the store and nothing else.
    const exported = buildExport(kb) as { project: { name: string | null } };
    expect(exported.project.name).toBe("svc");
  });
});

describe("more than one project in one file", () => {
  it("refuses to guess which workspace was meant", () => {
    // Answering about the wrong project looks exactly like answering about
    // the right one.
    const shared = join(workDir, "shared.sqlite");
    runAnalyze({ paths: [join(workDir, "svc")], dbPath: shared, readers: READERS });

    const other = join(workDir, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "index.ts"), "export const a = 1;\n");
    runAnalyze({ paths: [other], dbPath: shared, readers: READERS });

    const store2 = openStore(shared);
    try {
      expect(() => openKnowledgeBase(store2)).toThrow(AmbiguousWorkspaceError);
      // Named, it answers about the one asked for.
      expect(openKnowledgeBase(store2, undefined, other).snapshot.workspacePath).toBe(other);
    } finally {
      store2.close();
    }
  });
});


describe("what belongs to a capability", () => {
  it("keeps a capability's decisions to its own files", () => {
    // A decision is in a file, and a capability owns files. Nothing finer is
    // available, and claiming otherwise would attribute a branch to a
    // capability that never runs it.
    const features = kb.features();
    expect(features.length, "the fixture must produce a capability to scope").toBeGreaterThan(0);

    const all = kb.decisions();
    expect(all.length, "the fixture must produce a decision to scope").toBeGreaterThan(0);

    // The unrelated file holds a decision no capability owns. Without the
    // filter it would appear under one, so removing the filter fails here
    // rather than passing an assertion that restates the filter itself.
    const stray = all.filter((decision) => decision.source.relPath === "unrelated/audit.go");
    expect(stray.length, "the fixture must hold a decision outside any capability").toBe(1);

    // Compared by where it is, not by value: the decisions handed out carry
    // their branches' effects joined in, so a deep comparison against the
    // unjoined record never matches and the check could never fail.
    for (const feature of features) {
      const paths = kb.decisionsForFeature(feature.id).map((decision) => decision.source.relPath);
      expect(paths).not.toContain("unrelated/audit.go");
    }
  });

  it("returns nothing for a capability that does not exist", () => {
    expect(kb.decisionsForFeature("feat_nonexistent")).toEqual([]);
  });

  it("finds the screens whose address names the capability, and no others", () => {
    const leave = kb.features().find((feature) => feature.term === "leave");
    expect(leave, "the fixture must detect a leave capability").toBeDefined();

    const paths = kb.screensForFeature(leave!.id).map((screen) => screen.path);
    expect(paths).toContain("/my/leave/create");
    expect(paths).toContain("/manage/approval/leave/list");
    // A billing screen is not where leave is found.
    expect(paths).not.toContain("/manage/billing");
  });

  it("finds the status sets named for the capability, and no others", () => {
    const leave = kb.features().find((feature) => feature.term === "leave");
    const sets = kb.statusSetsForFeature(leave!.id);
    // The fixture declares LeaveStatusDraft/LeaveStatusApproved constants.
    expect(sets.length, "the fixture's leave status constants must be found").toBeGreaterThan(0);
    for (const set of sets) {
      expect(`${set.name} ${set.relPath}`.toLowerCase()).toContain("leave");
    }
  });

  it("returns no screens and no status sets for an unknown capability", () => {
    expect(kb.screensForFeature("feat_nonexistent")).toEqual([]);
    expect(kb.statusSetsForFeature("feat_nonexistent")).toEqual([]);
  });
});
