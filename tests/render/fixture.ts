/**
 * One analysed workspace and one template directory, shared by the render tests.
 *
 * Split out because `roundtrip.test.ts` reached 1,704 lines against a 500-line
 * working ceiling. `beforeAll` here runs once per test file that imports it, which
 * is the price of the split and is a few seconds.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

import { runAnalyze } from "../../engine/run/analyze.js";
import { openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { openKnowledgeBase, type KnowledgeBase } from "../../engine/kb/query.js";
import { loadTemplate, parseTemplate } from "../../engine/render/template.js";
import { prepare } from "../../engine/render/prepare.js";
import { createFrameworkRoutesProvider } from "../../engine/providers/frameworkroutes/provider.js";
import { createLogicProvider } from "../../engine/providers/logic/provider.js";
import { createSqlSchemaProvider } from "../../engine/datamodel/sql.js";
import { createDocumentationCollector } from "../../engine/collectors/documentation.js";
import { createSourceFileProvider } from "../../engine/providers/sourcefiles/provider.js";
import { createManifestProvider } from "../../engine/providers/manifests/provider.js";

const READERS = {
  structural: [
    createSourceFileProvider(),
    createManifestProvider(),
    createFrameworkRoutesProvider(),
    createLogicProvider(),
  ],
  data: [createSqlSchemaProvider()],
  collectors: [createDocumentationCollector()] };

export let workDir: string;
export let store: Store;
export let kb: KnowledgeBase;
export let templateDir: string;

export function write(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-render-"));
  write(join(workDir, "svc", "README.md"), "# Leave service\n\nHandles leave requests for staff across the whole company, end to end.\n");
  write(join(workDir, "svc", "go.mod"), "module example.com/svc\n\nrequire github.com/gin-gonic/gin v1.9.1\n");
  write(
    join(workDir, "svc", "migrations", "001.sql"),
    "CREATE TABLE leaves (id INT PRIMARY KEY, hours INT NOT NULL);\n",
  );
  write(
    join(workDir, "svc", "router.go"),
    'package main\n\nfunc Register(engine *gin.Engine) {\n\tv2 := engine.Group("/v2")\n\tv2.POST("/leaves", Apply)\n}\n',
  );

  // A template of our own, so these tests do not break every time a shipped
  // one is reworded.
  templateDir = join(workDir, "template");
  write(
    join(templateDir, "template.json"),
    JSON.stringify({
      id: "test",
      title: "$project",
      params: [],
      sections: [
        { id: "parts", kind: "code", heading: "Parts", fragment: "project-map", requires: ["run-context", "map-edges"] },
        {
          id: "intro",
          kind: "llm",
          heading: "Intro",
          prompt: "prompts/intro.md",
          requires: ["run-context"],
          contract: { maxWords: 20, maxHeadingLevel: 3 } },
        {
          id: "screens",
          kind: "code",
          heading: "Screens",
          fragment: "screens-table",
          requires: ["screens", "coverage:route"],
          omitWhenEmpty: true },
        {
          id: "limitations",
          kind: "code",
          heading: "Limits",
          fragment: "limitations",
          requires: ["coverage-notes", "extraction-failures"] },
      ] }),
  );
  write(join(templateDir, "prompts", "intro.md"), "# Intro\n\nSay what this is.\n");

  const dbPath = join(workDir, "kb.sqlite");
  runAnalyze({ paths: [join(workDir, "svc")], dbPath, readers: READERS });
  store = openStore(dbPath);
  kb = openKnowledgeBase(store);
});

afterAll(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

export function prepareInto(name: string, overrides: Record<string, unknown> = {}) {
  const outDir = join(workDir, "out", name);
  const template =
    Object.keys(overrides).length === 0
      ? loadTemplate(templateDir)
      : parseTemplate(
          JSON.stringify({
            ...JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8")),
            ...overrides }),
          templateDir,
        );
  return { outDir, result: prepare({ template, kb, outDir }) };
}

/**
 * Reopens the knowledge base after a test closes it.
 *
 * One test proves assembly needs no database by closing it mid-run. With the
 * fixture in its own module the bindings cannot be reassigned from outside, so the
 * reopening lives here beside the opening.
 */
export function reopen(): void {
  store = openStore(join(workDir, "kb.sqlite"));
  kb = openKnowledgeBase(store);
}
