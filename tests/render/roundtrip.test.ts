import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runAnalyze } from "../../engine/run/analyze.js";
import { openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { openKnowledgeBase, type KnowledgeBase } from "../../engine/kb/query.js";
import { loadTemplate, parseTemplate } from "../../engine/render/template.js";
import { prepare } from "../../engine/render/prepare.js";
import { assemble, writeAssembled, UnansweredSectionsError } from "../../engine/render/assemble.js";
import { resolveSelector, SelectorError } from "../../engine/render/selectors.js";
import { exportDocument, retarget, UnknownFormatError } from "../../engine/render/export.js";
import { hasFragment, renderFragment } from "../../engine/render/fragments.js";
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
    expect(partial).toContain("flowchart");
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
    expect(readFileSync(join(outDir, "report.partial.md"), "utf8")).toContain("flowchart");
  });

  it("emits a frame-translation task for a non-English report, and none for English", () => {
    const en = prepare({ template: loadTemplate(templateDir), kb, outDir: join(workDir, "out", "frame-en") });
    expect(en.tasks.map((task) => task.sectionId)).not.toContain("_frame");

    const zh = prepare({
      template: loadTemplate(templateDir),
      kb,
      outDir: join(workDir, "out", "frame-zh"),
      language: "zh-CN",
    });
    expect(zh.tasks.map((task) => task.sectionId)).toContain("_frame");
    // The glossary carries the template's own headings, so a new document needs
    // no change here to be translatable.
    const data = JSON.parse(
      readFileSync(join(workDir, "out", "frame-zh", "tasks", "_frame", "data.json"), "utf8"),
    ) as Record<string, string>;
    expect(data["heading:Parts"]).toBe("Parts");
    expect(data["col-from"]).toBe("From");
  });

  it("applies a supplied frame translation to headings and code, keeping answers", () => {
    const outDir = join(workDir, "out", "frame-apply");
    prepare({ template: loadTemplate(templateDir), kb, outDir, language: "zh-CN" });

    // The host answers the frame task and a prose section.
    writeFileSync(
      join(outDir, "tasks", "_frame", "answer.md"),
      JSON.stringify({ "heading:Parts": "部件", "col-from": "来源", contents: "目录" }),
    );
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), "写在中文里的介绍。");

    // The frame-only re-render: translated frame in, answers untouched.
    prepare({ template: loadTemplate(templateDir), kb, outDir, language: "zh-CN", preserveAnswers: true });

    const partial = readFileSync(join(outDir, "report.partial.md"), "utf8");
    expect(partial).toContain("## 部件");
    expect(partial).toContain("| 来源 |");
    expect(existsSync(join(outDir, "tasks", "intro", "answer.md"))).toBe(true);

    const assembled = assemble(outDir);
    const written = writeAssembled(outDir, assembled, { split: false });
    const document = readFileSync(written[0]!, "utf8");
    expect(document).toContain("## 目录");
    expect(document).toContain("写在中文里的介绍。");
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
        params: ["capability"],
        sections: [
          { id: "x", kind: "code", fragment: "capability-data", requires: ["feature-detail:$capability"] },
        ],
      }),
    ).toThrow(/--param capability=/);
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
    expect(result.markdown).toContain("flowchart");
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
    const features = kb.features();
    if (features.length === 0) return;

    const outDir = join(workDir, "out", "param-key");
    prepare({
      template: parseTemplate(
        JSON.stringify({
          id: "m",
          title: "$capability",
          params: ["capability"],
          sections: [
            { id: "data", kind: "code", heading: "Data", fragment: "capability-data", requires: ["feature-detail:$capability", "coverage:entity"] },
          ],
        }),
        templateDir,
      ),
      kb,
      outDir,
      params: { capability: features[0]!.id },
    });

    const partial = readFileSync(join(outDir, "report.partial.md"), "utf8");
    expect(partial).not.toContain("_Nothing to show here._");
  });

  it("refuses a param that names nothing in this knowledge base", () => {
    expect(() =>
      prepare({
        template: parseTemplate(
          JSON.stringify({
            id: "m",
            title: "$capability",
            params: ["capability"],
            sections: [
              { id: "s", kind: "code", fragment: "capability-data", requires: ["feature-detail:$capability"] },
            ],
          }),
          templateDir,
        ),
        kb,
        outDir: join(workDir, "out", "ghost-module"),
        params: { capability: "feat_does_not_exist" },
      }),
    ).toThrow(/Nothing in this knowledge base matches capability=feat_does_not_exist/);
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

  it("states each kind of limitation once, with a count, not once per file", () => {
    // 223 screens each noted that their path mirrors a component; the section
    // listed all 223. One line, "and N more", says the same thing readably.
    const failures = Array.from({ length: 40 }, (_, n) => ({
      providerId: "codegraph",
      scope: `src/pages/Screen${n}.tsx:1`,
      reason: `"/Screen${n}" mirrors a component's file path rather than an address`,
    }));
    const rendered = renderFragment("limitations", {
      kb,
      params: {},
      data: { "coverage-notes": [], "extraction-failures": failures },
    });
    const rows = rendered.split("\n").filter((line) => line.startsWith("| codegraph"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("and 37 more");
    // The per-file path is dropped from the reason, since it repeats the location.
    expect(rows[0]).not.toContain('"/Screen0"');
  });
});


describe("finding your way around a long report", () => {
  function prepared(name: string) {
    const { outDir } = prepareInto(name);
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), "### A sub-heading\n\nBody text.");
    return outDir;
  }

  it("puts contents after the title, covering sections and their sub-headings", () => {
    const outDir = prepared("toc");
    writeAssembled(outDir, assemble(outDir));
    const report = readFileSync(join(outDir, "report.md"), "utf8");

    const lines = report.split("\n");
    expect(lines[0]).toMatch(/^# /);
    expect(report).toContain("## Contents");
    expect(report).toContain("- [Parts](#parts)");
    // A heading an answer wrote is part of the document, so it is listed too.
    expect(report).toContain("[A sub-heading](#a-sub-heading)");
  });

  it("writes one file per section when asked, without changing what they say", () => {
    const outDir = prepared("split");
    const result = assemble(outDir);
    const written = writeAssembled(outDir, result, { split: true });

    expect(written.some((path) => path.endsWith("sections/parts.md"))).toBe(true);
    const part = readFileSync(join(outDir, "sections", "parts.md"), "utf8");
    // Moved, not rebuilt: the table is exactly the one in the whole document.
    expect(part).toContain("flowchart");
    expect(result.markdown).toContain(part.split("\n")[2]!);
  });

  it("keeps the limitations in the index rather than as one file among many", () => {
    // A reader who opens one section and never meets what the analysis could
    // not establish has been handed its most confident part on its own.
    const outDir = prepared("split-limits");
    writeAssembled(outDir, assemble(outDir), { split: true });

    const index = readFileSync(join(outDir, "index.md"), "utf8");
    expect(index).toContain("## Limits");
    expect(existsSync(join(outDir, "sections", "limitations.md"))).toBe(false);
  });

  it("does not list a heading that is only an example inside a code block", () => {
    const { outDir } = prepareInto("fenced-toc");
    writeFileSync(
      join(outDir, "tasks", "intro", "answer.md"),
      "Body.\n\n```md\n## Not a real section\n```\n",
    );
    writeAssembled(outDir, assemble(outDir));
    expect(readFileSync(join(outDir, "report.md"), "utf8")).not.toContain("[Not a real section]");
  });
});

describe("a format is a view, not a second document", () => {
  function assembled(name: string, split = true) {
    const { outDir } = prepareInto(name);
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), "Body text.");
    writeAssembled(outDir, assemble(outDir), { split });
    return outDir;
  }

  it("writes each format into its own tree, leaving the Markdown alone", () => {
    // Beside the Markdown, a ten-section report is twenty interleaved files
    // where half are views of the other half.
    const outDir = assembled("export-tree");
    const result = exportDocument(outDir, "html", "T");

    expect(result.outDir).toBe(join(outDir, "html"));
    expect(existsSync(join(outDir, "html", "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "html", "sections", "parts.html"))).toBe(true);
    // The Markdown tree stays exactly what assemble wrote.
    expect(existsSync(join(outDir, "sections", "parts.html"))).toBe(false);
  });

  it("points the document's own links at the format being rendered", () => {
    // `index.md` links to `sections/parts.md`, which is right for Markdown.
    // Left alone in a page, that link shows raw source instead of the page.
    const outDir = assembled("export-links");
    exportDocument(outDir, "html", "T");

    const index = readFileSync(join(outDir, "html", "index.html"), "utf8");
    expect(index).toContain('href="sections/parts.html"');
    expect(index).not.toContain('href="sections/parts.md"');
  });

  it("leaves a link that was not part of this document alone", () => {
    expect(retarget("[docs](https://example.com/a.md)", "html")).toBe(
      "[docs](https://example.com/a.md)",
    );
    expect(retarget("[s](sections/a.md#top)", "html")).toBe("[s](sections/a.html#top)");
  });

  it("exports an unsplit document too", () => {
    const outDir = assembled("export-whole", false);
    const result = exportDocument(outDir, "html", "T");
    expect(result.files).toContain("html/report.html");
  });

  it("draws mermaid as a diagram, not as its source", () => {
    // The map fragment renders a `flowchart` block; a reader wants the picture.
    const outDir = assembled("export-mermaid", false);
    exportDocument(outDir, "html", "T");
    const html = readFileSync(join(outDir, "html", "report.html"), "utf8");
    expect(html).toContain('<pre class="mermaid">');
    // Un-escaped so Mermaid can parse it, and the renderer is loaded.
    expect(html).toContain("flowchart");
    expect(html).toContain("mermaid.initialize");
    expect(html).not.toContain('class="language-mermaid"');
  });

  it("carries a left sidebar built from the document's own headings", () => {
    const outDir = assembled("export-nav", false);
    exportDocument(outDir, "html", "T");
    const html = readFileSync(join(outDir, "html", "report.html"), "utf8");
    expect(html).toContain('<nav id="sidebar">');
    // The sections appear as in-page links, and the scroll tracker is loaded.
    expect(html).toContain('href="#parts"');
    expect(html).toContain("getBoundingClientRect");
  });

  it("drops the inline contents from the page, keeping it in the Markdown", () => {
    // The sidebar shows the same list; rendered as well it would open every
    // page with a duplicate. The Markdown is the artifact and keeps its own.
    const outDir = assembled("export-contents", false);
    exportDocument(outDir, "html", "T");
    expect(readFileSync(join(outDir, "report.md"), "utf8")).toContain("## Contents");
    const html = readFileSync(join(outDir, "html", "report.html"), "utf8");
    expect(html).not.toContain(">Contents</h2>");
  });

  it("gives every split page a sidebar reaching every sibling section", () => {
    const outDir = assembled("export-split-nav");
    exportDocument(outDir, "html", "T");

    const section = readFileSync(join(outDir, "html", "sections", "parts.html"), "utf8");
    // The current page is marked, and the index is one link away.
    expect(section).toContain('aria-current="page"');
    expect(section).toContain('href="../index.html"');
    // Limitations stays in the index, so its entry points into the index page.
    expect(section).toContain('href="../index.html#limits"');
  });

  it("lands a sidebar link on a heading that contains an ampersand", () => {
    // "Issues & Risks" rendered as "Issues &amp; Risks", was slugged with the
    // entity, and every nav link to an "&" heading was dead.
    const outDir = assembled("export-ampersand", false);
    writeFileSync(
      join(outDir, "report.md"),
      "# T\n\n## Issues & Risks\n\nBody.\n",
    );
    exportDocument(outDir, "html", "T");
    const html = readFileSync(join(outDir, "html", "report.html"), "utf8");
    expect(html).toContain('id="issues-risks"');
    expect(html).toContain('href="#issues-risks"');
    expect(html).not.toContain("issues-amp-risks");
  });

  it("puts the view in a named directory and nothing else beside it", () => {
    // A deliverable folder holds only HTML; the Markdown, tasks and manifest
    // stay in the working directory a rebuild needs.
    const outDir = assembled("export-separate");
    const viewDir = join(workDir, "out", "export-separate-view");
    const result = exportDocument(outDir, "html", "T", viewDir);

    expect(result.outDir).toBe(viewDir);
    expect(existsSync(join(viewDir, "index.html"))).toBe(true);
    const everything = readdirSync(viewDir, { recursive: true }) as string[];
    expect(everything.filter((name) => name.endsWith(".md"))).toEqual([]);
    // The working directory did not grow an html tree of its own.
    expect(existsSync(join(outDir, "html"))).toBe(false);
  });

  it("refuses a format it does not have", () => {
    const outDir = assembled("export-unknown");
    expect(() => exportDocument(outDir, "docx", "T")).toThrow(UnknownFormatError);
  });

  it("refuses to export a document that was never assembled", () => {
    const { outDir } = prepareInto("export-nothing");
    rmSync(join(outDir, "report.md"), { force: true });
    expect(() => exportDocument(outDir, "html", "T")).toThrow(/Run `render assemble` first/);
  });
});

describe("rebuilding one section", () => {
  it("clears that answer and leaves the others where they are", () => {
    // A report with one bad section should cost one section to fix.
    const { outDir } = prepareInto("only-one");
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), "First answer.");

    prepare({ template: loadTemplate(templateDir), kb, outDir, only: "intro" });
    expect(existsSync(join(outDir, "tasks", "intro", "answer.md"))).toBe(false);
  });

  it("keeps another section's answer when rebuilding a different one", () => {
    const two = parseTemplate(
      JSON.stringify({
        id: "two",
        title: "T",
        sections: [
          { id: "a", kind: "llm", heading: "A", prompt: "prompts/intro.md", requires: [] },
          { id: "b", kind: "llm", heading: "B", prompt: "prompts/intro.md", requires: [] },
        ],
      }),
      templateDir,
    );
    const outDir = join(workDir, "out", "only-other");
    prepare({ template: two, kb, outDir });
    writeFileSync(join(outDir, "tasks", "a", "answer.md"), "Answer A.");
    writeFileSync(join(outDir, "tasks", "b", "answer.md"), "Answer B.");

    prepare({ template: two, kb, outDir, only: "a" });
    expect(existsSync(join(outDir, "tasks", "a", "answer.md"))).toBe(false);
    expect(readFileSync(join(outDir, "tasks", "b", "answer.md"), "utf8")).toBe("Answer B.");
  });

  it("refuses a section the template does not have, naming the ones it does", () => {
    const { outDir } = prepareInto("only-unknown");
    expect(() =>
      prepare({ template: loadTemplate(templateDir), kb, outDir, only: "invented" }),
    ).toThrow(/has no section "invented"/);
  });

  it("refuses to rebuild against a different analysis", () => {
    // The other answers were written from one snapshot. A section rebuilt
    // against another leaves the document describing two runs, and nothing
    // in the file would say so.
    const { outDir } = prepareInto("only-drifted");
    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, identity: "a-different-run" }));

    expect(() =>
      prepare({ template: loadTemplate(templateDir), kb, outDir, only: "intro" }),
    ).toThrow(/describing two runs/);
  });

  it("refuses to rebuild a section of a document that was never prepared", () => {
    expect(() =>
      prepare({
        template: loadTemplate(templateDir),
        kb,
        outDir: join(workDir, "out", "never-prepared"),
        only: "intro",
      }),
    ).toThrow(/Prepare it once/);
  });
});

describe("what was analyzed reaches the report", () => {
  /** A document made of the three sections these fragments fill. */
  function coverageDoc(name: string): string {
    const outDir = join(workDir, "out", name);
    prepare({
      template: parseTemplate(
        JSON.stringify({
          id: "cov",
          title: "$project",
          params: [],
          sections: [
            {
              id: "repositories",
              kind: "code",
              heading: "Repositories",
              fragment: "repositories",
              requires: ["repositories"],
              omitWhenEmpty: true,
            },
            {
              id: "dimensions",
              kind: "code",
              heading: "What Was Looked For",
              fragment: "analysis-dimensions",
              requires: ["analysis-dimensions"],
              omitWhenEmpty: true,
            },
            {
              id: "flows",
              kind: "code",
              heading: "Business Flow Coverage",
              fragment: "flow-coverage",
              requires: ["flow-coverage"],
              omitWhenEmpty: true,
            },
          ],
        }),
        templateDir,
      ),
      kb,
      outDir,
    });
    return readFileSync(join(outDir, "report.partial.md"), "utf8");
  }

  it("names every repository, with what was read of it as a proportion", () => {
    const report = coverageDoc("repos");
    expect(report).toContain("## Repositories");
    expect(report).toContain("| svc |");
    // A proportion, never a bare count: `6 of 8 (75%)`.
    expect(report).toMatch(/\| \d+ of \d+ \(\d+%\) \|/);
  });

  it("lists the fact kinds that were read, and the ones nobody looked for", () => {
    const report = coverageDoc("dimensions");
    expect(report).toContain("| route |");
    // No reader in this set supplies test relations, and saying so is the
    // difference between "the project has no tests" and "nothing looked".
    expect(report).toContain("Not looked for in this run");
    expect(report).toContain("- test-relation");
  });

  it("measures each capability's flows where a reader meets the diagrams", () => {
    const report = coverageDoc("flows");
    if (kb.features().length === 0) return;
    expect(report).toContain("## Business Flow Coverage");
    expect(report).toMatch(/\| Leave \| \d+ of \d+/);
  });

  it("says a version is a range rather than passing it off as installed", () => {
    // The fixture's go.mod pins exactly, and nothing else here has a lockfile,
    // so both states must be distinguishable in one report.
    const report = coverageDoc("versions");
    const stack = report.split("\n").find((line) => line.startsWith("- **svc**"));
    expect(stack, "the repository's stack line must be written").toBeDefined();
    expect(stack).toContain("github.com/gin-gonic/gin v1.9.1");
    expect(stack).not.toContain("v1.9.1✱");
  });

  it("carries the new labels into a translated report", () => {
    // Every label these sections add is a frame key, so a Chinese export
    // translates them without a dictionary in the engine.
    const outDir = join(workDir, "out", "repos-zh");
    prepare({
      template: parseTemplate(
        JSON.stringify({
          id: "cov",
          title: "$project",
          params: [],
          sections: [
            {
              id: "repositories",
              kind: "code",
              heading: "Repositories",
              fragment: "repositories",
              requires: ["repositories"],
            },
          ],
        }),
        templateDir,
      ),
      kb,
      outDir,
      language: "zh-CN",
    });

    const frame = JSON.parse(
      readFileSync(join(outDir, "tasks", "_frame", "data.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(frame)).toContain("col-repository");
    expect(Object.keys(frame)).toContain("role-serves-http");
  });
});
