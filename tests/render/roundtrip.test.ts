import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runAnalyze } from "../../engine/run/analyze.js";
import { openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { openKnowledgeBase, type KnowledgeBase } from "../../engine/kb/query.js";
import { loadTemplate, parseTemplate } from "../../engine/render/template.js";
import { prepare } from "../../engine/render/prepare.js";
import { assemble, UnansweredSectionsError } from "../../engine/render/assemble.js";
import { resolveSelector, SelectorError } from "../../engine/render/selectors.js";
import { hasFragment } from "../../engine/render/fragments.js";
import { createFrameworkRoutesProvider } from "../../engine/providers/frameworkroutes/provider.js";
import { createLogicProvider } from "../../engine/providers/logic/provider.js";
import { createSqlSchemaProvider } from "../../engine/datamodel/sql.js";
import { createDocumentationCollector } from "../../engine/collectors/documentation.js";

const READERS = {
  structural: [createFrameworkRoutesProvider(), createLogicProvider()],
  data: [createSqlSchemaProvider()],
  collectors: [createDocumentationCollector()],
};

let workDir: string;
let store: Store;
let kb: KnowledgeBase;
let templateDir: string;

function write(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-render-"));
  write(join(workDir, "svc", "README.md"), "# Leave service\n\nHandles leave for staff.\n");
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
        { id: "parts", kind: "code", heading: "Parts", fragment: "project-summary", requires: ["run-context"] },
        {
          id: "intro",
          kind: "llm",
          heading: "Intro",
          prompt: "prompts/intro.md",
          requires: ["run-context"],
          contract: { maxWords: 20, maxHeadingLevel: 3 },
        },
        {
          id: "screens",
          kind: "code",
          heading: "Screens",
          fragment: "screens-table",
          requires: ["screens", "coverage:route"],
          omitWhenEmpty: true,
        },
        {
          id: "limitations",
          kind: "code",
          heading: "Limits",
          fragment: "limitations",
          requires: ["coverage-notes", "extraction-failures"],
        },
      ],
    }),
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

function prepareInto(name: string, overrides: Record<string, unknown> = {}) {
  const outDir = join(workDir, "out", name);
  const template =
    Object.keys(overrides).length === 0
      ? loadTemplate(templateDir)
      : parseTemplate(
          JSON.stringify({
            ...JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8")),
            ...overrides,
          }),
          templateDir,
        );
  return { outDir, result: prepare({ template, kb, outDir }) };
}

describe("prepare", () => {
  it("renders code sections and leaves a marked hole per llm section", () => {
    const { outDir, result } = prepareInto("basic");
    const partial = readFileSync(join(outDir, "report.partial.md"), "utf8");

    expect(result.tasks.map((task) => task.sectionId)).toEqual(["intro"]);
    expect(partial).toContain("<!-- llm:intro:begin -->");
    expect(partial).toContain("| Part | Language |");
    // The title takes the project's own name.
    expect(partial.split("\n")[0]).toBe("# svc");
  });

  it("gives each task its prompt and only the data that prompt may use", () => {
    const { outDir } = prepareInto("slice");
    const dir = join(outDir, "tasks", "intro");
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toContain("Say what this is");
    const data = JSON.parse(readFileSync(join(dir, "data.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["run-context"]);
  });

  it("states in every prompt that the data slice is the limit of what may be said", () => {
    const { outDir } = prepareInto("rules");
    const prompt = readFileSync(join(outDir, "tasks", "intro", "prompt.md"), "utf8");
    expect(prompt).toContain("data.json");
    expect(prompt).toContain("Never invent");
    expect(prompt).toContain("At most 20 words");
  });

  it("omits an empty section only when its content is empty, not its coverage", () => {
    // Coverage answers how to read an empty section, so counting it kept
    // every section that asked for one.
    const { result } = prepareInto("omit");
    expect(result.omitted).toEqual(["screens"]);
  });

  it("appends the language to prompts rather than translating anything itself", () => {
    const outDir = join(workDir, "out", "lang");
    prepare({ template: loadTemplate(templateDir), kb, outDir, language: "Chinese" });
    const prompt = readFileSync(join(outDir, "tasks", "intro", "prompt.md"), "utf8");
    expect(prompt).toContain("Write in Chinese");
    // Code sections are identifiers and numbers; they do not translate.
    expect(readFileSync(join(outDir, "report.partial.md"), "utf8")).toContain("| Part |");
  });

  it("refuses an unknown selector with the vocabulary, not an empty slice", () => {
    // An empty slice would read as "the project has none".
    expect(() =>
      prepareInto("bad-selector", {
        sections: [{ id: "x", kind: "code", fragment: "limitations", requires: ["invented"] }],
      }),
    ).toThrow(SelectorError);
  });

  it("refuses a template that needs a parameter it was not given", () => {
    expect(() =>
      prepareInto("no-param", {
        params: ["module"],
        sections: [
          { id: "x", kind: "code", fragment: "module-surface", requires: ["module-detail:$module"] },
        ],
      }),
    ).toThrow(/--param module=/);
  });
});

describe("assemble", () => {
  function answer(outDir: string, text: string): void {
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), text);
  }

  it("splices an answer into its own section and nowhere else", () => {
    const { outDir } = prepareInto("splice");
    answer(outDir, "A short answer about the service.");
    const result = assemble(outDir);

    expect(result.markdown).toContain("A short answer about the service.");
    expect(result.markdown).toContain("| Part | Language |");
    expect(result.outcomes[0]!.filled).toBe(true);
  });

  it("is deterministic given the same answers", () => {
    const { outDir } = prepareInto("stable");
    answer(outDir, "A short answer about the service.");
    expect(assemble(outDir).markdown).toBe(assemble(outDir).markdown);
  });

  it("refuses a missing answer rather than publishing a silent gap", () => {
    const { outDir } = prepareInto("missing");
    expect(() => assemble(outDir)).toThrow(UnansweredSectionsError);
  });

  it("states the gap in the document when told to publish anyway", () => {
    const { outDir } = prepareInto("allow-missing");
    const result = assemble(outDir, true);
    expect(result.markdown).toContain("This section was not written");
    expect(result.outcomes[0]!.filled).toBe(false);
  });

  it("refuses an answer that breaks its contract", () => {
    const { outDir } = prepareInto("too-long");
    answer(outDir, Array.from({ length: 40 }, (_, n) => `word${n}`).join(" "));
    expect(() => assemble(outDir)).toThrow(/40 words, at most 20/);
  });

  it("refuses an answer whose headings would outrank the document", () => {
    const { outDir } = prepareInto("shallow");
    answer(outDir, "# A top-level heading\n\nBody.");
    expect(() => assemble(outDir)).toThrow(/shallower than level 3/);
  });

  it("refuses an answer carrying a section marker", () => {
    const { outDir } = prepareInto("marker");
    answer(outDir, "Fine text <!-- llm:intro:end --> and then more.");
    expect(() => assemble(outDir)).toThrow(/section marker/);
  });

  it("warns about a citation the section's own data does not contain", () => {
    const { outDir } = prepareInto("citation");
    answer(outDir, "The service is named [kb:not-in-the-slice].");
    const result = assemble(outDir, true);
    expect(result.outcomes[0]!.problems.map((problem) => problem.severity)).toContain("warning");
    // A warning is not a refusal: the sentence may still be true.
    expect(result.outcomes[0]!.filled).toBe(true);
  });

  it("never opens the knowledge base", () => {
    // Assembly is a file operation, which is what lets one section be
    // re-answered without re-running the analysis.
    const { outDir } = prepareInto("no-db");
    answer(outDir, "A short answer about the service.");
    store.close();
    try {
      expect(assemble(outDir).markdown).toContain("A short answer");
    } finally {
      store = openStore(join(workDir, "kb.sqlite"));
      kb = openKnowledgeBase(store);
    }
  });
});

describe("what the review found", () => {
  it("hands a fragment data a parameterized selector fetched", () => {
    // The section writes `module-flows:$module`; the fragment asks for
    // `module-flows`. Keyed only as written, every module document said
    // "nothing to show" over flows it had been given.
    const modules = kb.modules();
    if (modules.length === 0) return;

    const outDir = join(workDir, "out", "param-key");
    prepare({
      template: parseTemplate(
        JSON.stringify({
          id: "m",
          title: "$module",
          params: ["module"],
          sections: [
            { id: "flows", kind: "code", heading: "Flows", fragment: "module-surface", requires: ["module-detail:$module"] },
          ],
        }),
        templateDir,
      ),
      kb,
      outDir,
      params: { module: modules[0]!.id },
    });

    const partial = readFileSync(join(outDir, "report.partial.md"), "utf8");
    expect(partial).not.toContain("_Nothing to show here._");
    expect(partial).toContain("| Part | Symbols |");
  });

  it("refuses a param that names nothing in this knowledge base", () => {
    expect(() =>
      prepare({
        template: parseTemplate(
          JSON.stringify({
            id: "m",
            title: "$module",
            params: ["module"],
            sections: [
              { id: "s", kind: "code", fragment: "module-surface", requires: ["module-detail:$module"] },
            ],
          }),
          templateDir,
        ),
        kb,
        outDir: join(workDir, "out", "ghost-module"),
        params: { module: "mod_does_not_exist" },
      }),
    ).toThrow(/Nothing in this knowledge base matches module=mod_does_not_exist/);
  });

  it("keeps a section that asks only for what could not be established", () => {
    // `coverage-notes` matched a `coverage` prefix meant for `coverage:<kind>`,
    // so the section whose job is stating limits was always omitted.
    const outDir = join(workDir, "out", "limits");
    prepare({
      template: parseTemplate(
        JSON.stringify({
          id: "l",
          title: "T",
          sections: [
            {
              id: "limitations",
              kind: "code",
              heading: "Limits",
              fragment: "limitations",
              requires: ["coverage-notes"],
              omitWhenEmpty: true,
            },
          ],
        }),
        templateDir,
      ),
      kb,
      outDir,
    });
    expect(readFileSync(join(outDir, "report.partial.md"), "utf8")).toContain("## Limits");
  });

  it("clears an answer written from an older slice", () => {
    const { outDir } = prepareInto("stale");
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), "Written from the old data.");
    prepare({ template: loadTemplate(templateDir), kb, outDir });
    expect(existsSync(join(outDir, "tasks", "intro", "answer.md"))).toBe(false);
  });

  it("refuses a section the prepared document has no hole for", () => {
    const { outDir } = prepareInto("no-marker");
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), "An answer.");
    const partialPath = join(outDir, "report.partial.md");
    writeFileSync(
      partialPath,
      readFileSync(partialPath, "utf8").replaceAll(/<!-- llm:intro:(begin|end) -->/g, ""),
    );
    expect(() => assemble(outDir)).toThrow(/no marker for this section/);
  });

  it("refuses when a task directory named by the manifest is missing", () => {
    // Enumerating tasks/ alone, an unwritten section left its marker in the
    // document and assemble exited 0.
    const { outDir } = prepareInto("no-task");
    rmSync(join(outDir, "tasks", "intro"), { recursive: true, force: true });
    expect(() => assemble(outDir)).toThrow(UnansweredSectionsError);
  });

  it("says an answer was refused rather than never written", () => {
    const { outDir } = prepareInto("refused");
    writeFileSync(
      join(outDir, "tasks", "intro", "answer.md"),
      Array.from({ length: 40 }, (_, n) => `word${n}`).join(" "),
    );
    const result = assemble(outDir, true);
    expect(result.markdown).toContain("written but refused");
    expect(result.markdown).not.toContain("was not written.");
  });

  it("counts headings outside fenced code, and allows sub-headings under each item", () => {
    const { outDir } = prepareInto("headings");
    writeFileSync(
      join(outDir, "tasks", "intro", "answer.md"),
      "Body.\n\n```md\n# not a heading\n```\n",
    );
    expect(() => assemble(outDir)).not.toThrow();
  });

  it("does not treat an inherited property as a fragment or a selector", () => {
    expect(hasFragment("toString")).toBe(false);
    expect(() => resolveSelector(kb, "toString", {})).toThrow(SelectorError);
  });
});
