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
import { FRAME_EN } from "../../engine/render/strings.js";
import { undrawableDiagramLines } from "../../engine/render/validate.js";
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

/**
 * The silence sections, tested on their input rather than on a codebase.
 *
 * These assert properties no target's contents can settle: that the truncation
 * accounting adds up, that every repository is named, that nothing bypasses the
 * frame. Real behaviour — which files are silent and why — is graded against WCP
 * in `tests/run/real-targets.test.ts`, because a hand-written codebase shaped to
 * be convenient to analyze would flatter the tool. A list of records is not a
 * codebase; it is fragment input, the same as every other fragment test here.
 */
describe("where a report stopped reading", () => {
  function silentFile(rootName: string, n: number, sizeBytes = 2048) {
    return { rootName, relPath: `src/part${n}.ts`, sizeBytes };
  }

  function render(
    files: readonly { rootName: string; relPath: string; sizeBytes: number }[],
    unread: readonly { rootName: string; relPath: string; sizeBytes: number }[] = [],
  ) {
    return renderFragment("silent-files", {
      kb,
      params: {},
      data: { "silent-files": files, "unread-files": unread },
    });
  }

  /** Rows in the tables, and what the "and N more" lines add up to. */
  function accounting(rendered: string): { rows: number; more: number } {
    const rows = rendered
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.includes("| Size |"));
    const more = rendered
      .split("\n")
      .flatMap((line) => [...line.matchAll(/and (\d+) more/g)].map((m) => Number(m[1])));
    return { rows: rows.length, more: more.reduce((sum, n) => sum + n, 0) };
  }

  it("accounts for every file it was given, shown or summarised", () => {
    // The invariant the truncation limit's own comment claims: what is dropped is
    // counted, so a truncated list never reads as a complete one. Independent of
    // the limit's value, so tightening or widening it cannot break the promise.
    const files = [
      ...Array.from({ length: 10 }, (_, n) => silentFile("api", n, 9000 - n)),
      ...Array.from({ length: 3 }, (_, n) => silentFile("ui", n, 500 - n)),
    ];
    const { rows, more } = accounting(render(files));
    expect(rows + more).toBe(files.length);
    expect(more).toBeGreaterThan(0);

    // And enough of each repository to be worth reading. A limit of one would
    // keep the accounting honest and the section useless, so the property is
    // "several per repository" rather than the constant's exact value.
    expect(rows).toBeGreaterThan(4);
  });

  it("names every repository that has a silence, however large its neighbours", () => {
    // A global top-N is decided by the biggest repository: on a real workspace 22
    // of 25 rows came from the front end and two repositories were named nowhere.
    const files = [
      ...Array.from({ length: 30 }, (_, n) => silentFile("big", n, 20_000 - n)),
      silentFile("small", 0, 300),
    ];
    const rendered = render(files);
    expect(rendered).toContain("big");
    expect(rendered).toContain("small");
    expect(rendered).toContain("src/part0.ts");
  });

  it("puts every word through the frame, so a translation cannot leak English", () => {
    // Every value replaced by its own key: anything left in English bypassed t(),
    // and a bracketed key means a string the frame does not carry.
    const marked = Object.fromEntries(
      Object.keys(FRAME_EN).map((key) => [key, `<<${key}>>`]),
    ) as typeof FRAME_EN;
    const rendered = renderFragment("silent-files", {
      kb,
      params: {},
      frame: marked,
      data: { "silent-files": [silentFile("api", 1)], "unread-files": [silentFile("api", 2)] },
    });

    expect(rendered).toContain("<<silent-lead>>");
    expect(rendered).toContain("<<unread-lead>>");
    expect(rendered).toContain("<<silent-note>>");
    expect(rendered).toContain("<<col-file>>");
    expect(rendered).not.toMatch(/\[[a-z-]+\]/);
    expect(rendered).not.toMatch(/[Ss]topped reading|behaviour was extracted/);
  });

  it("says nothing was missed when nothing was, rather than printing an empty table", () => {
    const rendered = render([]);
    expect(rendered).not.toBe("");
    expect(rendered).not.toContain("| ---");
  });

  it("keeps a file nothing was read from apart from one that was", () => {
    // Two facts, and conflating them was wrong in both directions: folding the
    // unread into the silent led the list with a file that is entirely commented
    // out, and dropping them hid forty-one model files declaring tables.
    const rendered = render([silentFile("api", 1, 4000)], [silentFile("api", 2, 3000)]);
    expect(rendered).toContain("src/part1.ts");
    expect(rendered).toContain("src/part2.ts");
    // Each group gets its own claim, and the unread one is the stronger.
    const silentAt = rendered.indexOf("extracted from these files");
    const unreadAt = rendered.indexOf("nothing at all was extracted");
    expect(silentAt).toBeGreaterThanOrEqual(0);
    expect(unreadAt).toBeGreaterThan(silentAt);
  });

  it("accounts for both groups together", () => {
    const silent = Array.from({ length: 10 }, (_, n) => silentFile("api", n, 9000 - n));
    const unread = Array.from({ length: 12 }, (_, n) => silentFile("ui", n, 500 - n));
    const { rows, more } = accounting(render(silent, unread));
    expect(rows + more).toBe(silent.length + unread.length);
  });

  it("says nothing was missed only when neither group has anything", () => {
    // A capability with no silent file but an unread one has something to report.
    expect(render([], [silentFile("api", 1)])).toContain("src/part1.ts");
  });

  it("shows a size a reader can weigh, at the boundary either side", () => {
    expect(render([silentFile("api", 1, 1023)])).toContain("1023 bytes");
    expect(render([silentFile("api", 1, 1024)])).toContain("1 KB");
  });
});


/**
 * The recovered-specification fragments, checked for keys that do not exist.
 *
 * A key with no string renders as `[key]` — the fallback is deliberate, so a
 * missing word degrades rather than throws, which means nothing fails until a
 * reader sees a bracket in a document. `[col-endpoints]` reached a rendered PRD
 * exactly that way.
 */
describe("the recovered specification's own sections", () => {
  const marked = Object.fromEntries(
    Object.keys(FRAME_EN).map((key) => [key, `<<${key}>>`]),
  ) as typeof FRAME_EN;

  const cases: readonly { fragment: string; data: Readonly<Record<string, unknown>> }[] = [
    {
      fragment: "prd-features",
      data: {
        features: [
          {
            id: "feat_a",
            name: "Leave",
            term: "leave",
            signals: ["26 endpoints", "3 data entities"],
            filePaths: [],
            endpoints: [
              { method: "POST", path: "/v2/leaves", rootName: "svc" },
              { method: "GET", path: "/v2/leaves/me", rootName: "svc" },
            ],
            tables: ["wcp_leave", "wcp_leave_detail"],
          },
          {
            id: "feat_b",
            name: "Billing",
            term: "billing",
            signals: ["32 endpoints"],
            filePaths: [],
            endpoints: [{ method: "GET", path: "/v2/bills", rootName: "svc" }],
            tables: [],
          },
        ],
      },
    },
    {
      fragment: "prd-pages",
      data: {
        screens: [
          { rootName: "ui", path: "/manage/employee/list", method: null, middleware: [], handlerName: null },
          { rootName: "ui", path: "/manage/employee/:id", method: null, middleware: [], handlerName: null },
          { rootName: "ui", path: "/leave/apply", method: null, middleware: [], handlerName: null },
        ],
      },
    },
    {
      fragment: "prd-validation",
      data: {
        guards: [
          {
            rootName: "svc",
            message: "Comment is required when status is rejected.",
            messageKind: "stated",
            test: "status == rejected",
            source: { relPath: "a.go", line: 1 },
          },
          {
            rootName: "svc",
            message: "ErrNotFound",
            messageKind: "error-code",
            test: "found == false",
            source: { relPath: "b.go", line: 2 },
          },
        ],
      },
    },
    {
      fragment: "prd-not-recoverable",
      data: {
        "silent-files": [{ rootName: "svc", relPath: "a.go", sizeBytes: 900 }],
        "unread-files": [{ rootName: "svc", relPath: "b.js", sizeBytes: 800 }],
        "coverage-notes": [{ subject: "route", note: "some limit" }],
      },
    },
  ];

  for (const { fragment, data } of cases) {
    it(`${fragment} states every word through the frame`, () => {
      const rendered = renderFragment(fragment, { kb, params: {}, frame: marked, data });
      expect(rendered).not.toBe("");
      // A bracketed key is the fallback for a string the frame does not carry.
      expect(rendered, `${fragment} rendered a key with no string`).not.toMatch(/\[[a-z][a-z0-9-]*\]/);
      // And nothing bypassed t(): every word came from the marked glossary.
      expect(rendered).toMatch(/<<[a-z-]+>>/);
    });
  }
});

/**
 * The recovered specification's tables, on their inputs.
 *
 * Nine of ten mutations of these fragments once survived the whole suite —
 * changing a truncation limit, dropping a truncation notice, reversing a sort,
 * breaking the identifier padding, mislabelling a count. Each assertion below
 * kills one, and none depends on any target's contents.
 */
describe("the recovered specification's tables", () => {
  function feature(name: string, endpoints: number, tables: readonly string[] = []) {
    return {
      id: `feat_${name}`,
      name,
      term: name.toLowerCase(),
      signals: [],
      filePaths: [],
      tables: [...tables],
      endpoints: Array.from({ length: endpoints }, (_, n) => ({
        method: "GET",
        path: `/${name.toLowerCase()}/${n}`,
        rootName: "svc",
      })),
    };
  }

  function screen(rootName: string, path: string) {
    return { rootName, path, method: null, middleware: [], handlerName: null };
  }

  function guard(rootName: string, relPath: string, message: string, test: string) {
    return { rootName, message, messageKind: "stated", test, source: { relPath, line: 1 } };
  }

  const render = (fragment: string, data: Readonly<Record<string, unknown>>) =>
    renderFragment(fragment, { kb, params: {}, data });

  it("numbers capabilities by surface area, widest first, zero-padded", () => {
    // Named against alphabetical order deliberately: `Large/Middle/Small` sorts the
    // same way under both rules, so the assertion held under pure alphabetical.
    const rendered = render("prd-features", {
      features: [feature("Alpha", 2), feature("Zulu", 30), feature("Mike", 9)],
    });
    const ids = [...rendered.matchAll(/\| (F\d+) \| (\w+)/g)].map((m) => [m[1], m[2]]);
    expect(ids).toEqual([
      ["F001", "Zulu"],
      ["F002", "Mike"],
      ["F003", "Alpha"],
    ]);
  });

  it("names a capability's addresses and tables, not only how many", () => {
    // "Billing — 32 endpoints" and not one path is what a rebuild team was given.
    const rendered = render("prd-features", {
      features: [feature("Leave", 2, ["wcp_leave", "wcp_leave_detail"])],
    });
    expect(rendered).toContain("/leave/0");
    expect(rendered).toContain("wcp_leave_detail");
  });

  it("counts every address it does not name", () => {
    const rendered = render("prd-features", { features: [feature("Wide", 30)] });
    const more = Number(/and (\d+) more/.exec(rendered)?.[1]);
    const shown = [...rendered.matchAll(/\/wide\/\d+/g)].length;
    expect(shown + more).toBe(30);
  });

  it("keeps two front ends apart and counts an address once", () => {
    // Grouping on the path alone merged them and counted a shared path twice.
    const rendered = render("prd-pages", {
      screens: [screen("ui-a", "/login"), screen("ui-b", "/login")],
    });
    expect(rendered).toContain("ui-a");
    expect(rendered).toContain("ui-b");
    expect(rendered).not.toMatch(/\| \/login \| 2 \|/);
  });

  it("groups pages two segments deep, so an area is navigable", () => {
    // One repository put 132 of 182 addresses under `/manage` and listed six.
    // Asserted on the area headings rather than on the address column, where
    // `/manage/leave` appears as a substring however the grouping is done.
    const rendered = render("prd-pages", {
      screens: [
        screen("ui", "/manage/leave/list"),
        screen("ui", "/manage/leave/:id"),
        screen("ui", "/manage/employee/list"),
      ],
    });
    const areas = [...rendered.matchAll(/^\| (\/\S+) \|/gm)].map((m) => m[1]);
    expect(areas).toEqual(["/manage/leave", "/manage/employee"]);
  });

  it("accounts for every page, shown or summarised", () => {
    const screens = Array.from({ length: 20 }, (_, n) => screen("ui", `/area/sub/page${n}`));
    const rendered = render("prd-pages", { screens });
    const more = Number(/and (\d+) more/.exec(rendered)?.[1] ?? 0);
    const shown = [...rendered.matchAll(/\/area\/sub\/page\d+/g)].length;
    expect(shown + more).toBe(20);
    // And enough of each area to be worth reading. The accounting holds for any
    // limit, including one, so the property is "several per area" rather than the
    // constant's value — a section naming one page in seven is not a page map.
    expect(shown).toBeGreaterThan(4);
  });

  it("survives a root address without rendering a doubled slash", () => {
    expect(render("prd-pages", { screens: [screen("ui", "/")] })).not.toContain("//");
  });

  it("says when a rule fires and where it is, not only what it says", () => {
    // A message alone cannot be reproduced, and cannot be gone and read either.
    const rendered = render("prd-validation", {
      guards: [guard("svc", "leave.go", "Not enough holiday.", "available < requested")],
    });
    expect(rendered).toContain("available < requested");
    expect(rendered).toContain("svc/leave.go");
  });

  it("does not rank rules by how often their message repeats", () => {
    // Ranking that way filled every row with a repeated message, hid 623 rules
    // stated once each, and let a repeated CSS value outrank a real rule.
    const many = Array.from({ length: 3 }, (_, n) =>
      guard("svc", `dup${n}.go`, "zzz repeated everywhere", "x"),
    );
    const one = guard("svc", "a.go", "aaa stated once", "y");
    const rendered = render("prd-validation", { guards: [...many, one] });
    expect(rendered.indexOf("aaa stated once")).toBeLessThan(
      rendered.indexOf("zzz repeated everywhere"),
    );
  });

  it("keeps each repository's rules under its own heading", () => {
    const rendered = render("prd-validation", {
      guards: [guard("api", "a.go", "Api rejects this.", "x"), guard("ui", "b.tsx", "Ui rejects this.", "y")],
    });
    expect(rendered).toContain("api");
    expect(rendered).toContain("ui");
  });

  it("states each condition on its own line, not joined into one trigger", () => {
    // `status === 0 · status === UserStatus.Inactive` are two mutually exclusive
    // checks in two files; under a column headed "When" they read as a conjunction
    // and a rebuild implements it.
    const rendered = render("prd-validation", {
      guards: [
        guard("svc", "a.go", "Add User", "status === 0"),
        guard("svc", "b.go", "Add User", "status === UserStatus.Inactive"),
      ],
    });
    expect(rendered).toContain("status === 0<br>status === UserStatus.Inactive");
    expect(rendered).not.toContain("·");
  });

  it("counts the conditions it does not show", () => {
    // 78 of WCP's messages have more than one distinct condition and one has
    // thirteen; past the second they were dropped with nothing said.
    const guards = Array.from({ length: 6 }, (_, n) =>
      guard("svc", `f${n}.go`, "Rejected.", `check${n}()`),
    );
    const rendered = render("prd-validation", { guards });
    const shown = [...rendered.matchAll(/check\d\(\)/g)].length;
    const more = Number(/and (\d+) more/.exec(rendered)?.[1] ?? 0);
    expect(shown + more).toBe(6);
    expect(more).toBeGreaterThan(0);
  });

  it("prints a rule enforced in two repositories under each of them", () => {
    // Filed under whichever file was walked first, WCP's password rules appeared
    // once, under a proposal-share modal, and never among the 493 rules of the
    // service that also enforces them.
    const rendered = render("prd-validation", {
      guards: [
        guard("ui", "Modal.tsx", "Password must be 6 digits long.", "!/^\\d{6}$/.test(value)"),
        guard("api", "service.go", "Password must be 6 digits long.", "len(p.Password) != 6"),
      ],
    });
    const rows = rendered.split("\n").filter((line) => line.includes("Password must be 6 digits"));
    expect(rows).toHaveLength(2);
    expect(rendered).toContain(FRAME_EN["also-in-other-repositories"]!.replace("{0}", "1"));
  });

  it("shows only the conditions the repository under the heading states", () => {
    // The cross-root union printed wcp-service-v2's Go whitelist under
    // wcp_review_service's heading, where the allowed set is a different one.
    const rendered = render("prd-validation", {
      guards: [
        guard("ui", "Modal.tsx", "sort params is invalid", 'sortable.includes("full_name")'),
        guard("api", "service.go", "sort params is invalid", 'sortable.includes("status")'),
      ],
    });
    const uiRow = rendered.split("\n").find((line) => line.includes("Modal.tsx"))!;
    const apiRow = rendered.split("\n").find((line) => line.includes("service.go"))!;
    expect(uiRow).toContain("full_name");
    expect(uiRow).not.toContain("status");
    expect(apiRow).toContain("status");
    expect(apiRow).not.toContain("full_name");
  });

  it("names only this repository's files under its heading", () => {
    const rendered = render("prd-validation", {
      guards: [
        guard("ui", "Modal.tsx", "Shared rejection.", "x"),
        guard("api", "service.go", "Shared rejection.", "y"),
      ],
    });
    const uiRow = rendered.split("\n").find((line) => line.includes("Modal.tsx"))!;
    expect(uiRow).not.toContain("service.go");
  });

  it("prints every rule a repository states on this scale", () => {
    // The cap was 400 against a service holding 493 distinct messages, so the
    // document shipped ending that table with 93 of its rules absent.
    const guards = Array.from({ length: 493 }, (_, n) =>
      guard("svc", `f${n}.go`, `Rejection number ${String(n).padStart(3, "0")}.`, `c${n}()`),
    );
    const rendered = render("prd-validation", { guards });
    expect(rendered).toContain("Rejection number 492.");
    expect(rendered).not.toMatch(/^and \d+ more$/m);
  });

  function flow(
    featureId: string,
    entry: string,
    options: { partial?: boolean; vague?: number; steps?: number } = {},
  ) {
    const steps = Array.from({ length: options.steps ?? 2 }, (_, n) => ({
      kind: n === 0 ? "entry" : "data-access",
      label: `step${n}`,
      conditions: [],
      unresolvedReason: null,
      indirect: n > 0 && n <= (options.vague ?? 0),
    }));
    return {
      featureId,
      entryKey: entry,
      partial: options.partial ?? false,
      steps,
      diagram: `flowchart LR\n  s0["${entry}"]`,
    };
  }

  it("draws the traced flows themselves, not numbers about the analysis", () => {
    // The section rendered how much of each capability had been followed — two
    // numbers about the analysis, under a heading promising the system's behaviour.
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:POST /leaves")],
      features: [feature("Leave", 1)],
    });
    expect(rendered).toContain("```mermaid");
    expect(rendered).toContain("svc:POST /leaves");
  });

  it("draws a complete trace before one with a gap", () => {
    const rendered = render("prd-flows", {
      flows: [
        flow("feat_Leave", "svc:GET /partial", { partial: true }),
        flow("feat_Leave", "svc:GET /whole"),
      ],
      features: [feature("Leave", 2)],
    });
    expect(rendered.indexOf("/whole")).toBeLessThan(rendered.indexOf("/partial"));
  });

  it("draws a trace observed in the handler before one observed in its package", () => {
    // The section opened on a delete endpoint drawn against 13 tables, every edge
    // dotted and labelled "observed in the handler's package". Same step count on
    // both, or the shorter-trace tiebreak would order them without this rule.
    const rendered = render("prd-flows", {
      flows: [
        // Named so that alphabetical order opposes the rule under test: without
        // the package-scope term, the entry-key tiebreak alone would order these
        // correctly and the assertion would hold for the wrong reason.
        flow("feat_Leave", "svc:GET /a-vague", { vague: 3, steps: 4 }),
        flow("feat_Leave", "svc:GET /z-crisp", { vague: 0, steps: 4 }),
      ],
      features: [feature("Leave", 2)],
    });
    expect(rendered.indexOf("/z-crisp")).toBeLessThan(rendered.indexOf("/a-vague"));
  });

  it("draws at most a couple of flows for one capability", () => {
    // A diagram is a page each: WCP's Review capability alone has 55 flows, and
    // drawing them all is how the section came to 2,068 lines.
    const flows = Array.from({ length: 9 }, (_, n) => flow("feat_Leave", `svc:GET /f${n}`));
    const rendered = render("prd-flows", { flows, features: [feature("Leave", 9)] });
    expect(rendered.split("```mermaid").length - 1).toBeLessThan(4);
  });

  it("draws flows for some capabilities, not for forty-eight", () => {
    const features = Array.from({ length: 20 }, (_, n) => feature(`Cap${n}`, n + 1));
    const flows = features.map((f) => flow(f.id, `svc:GET /${f.name}`));
    const rendered = render("prd-flows", { flows, features });
    const drawn = rendered.split("```mermaid").length - 1;
    expect(drawn).toBeLessThan(features.length);
    expect(drawn).toBeGreaterThan(0);
    // And what is left out is still accounted for.
    expect(Number(/(\d+) of 20 traced flow/.exec(rendered)?.[1] ?? 0)).toBe(features.length - drawn);
  });

  it("accounts for every flow it does not draw", () => {
    const flows = Array.from({ length: 9 }, (_, n) => flow("feat_Leave", `svc:GET /f${n}`));
    const rendered = render("prd-flows", { flows, features: [feature("Leave", 9)] });
    const drawn = rendered.split("```mermaid").length - 1;
    const left = Number(/(\d+) of 9 traced flow/.exec(rendered)?.[1] ?? 0);
    expect(drawn + left).toBe(9);
    expect(drawn).toBeGreaterThan(0);
  });

  it("counts a capability's partial flows, and does not call them established", () => {
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a", { partial: true }), flow("feat_Leave", "svc:GET /b")],
      features: [feature("Leave", 2)],
    });
    expect(rendered).toContain(
      FRAME_EN["prd-flow-partial"]!.replace("{0}", "1").replace("{1}", "2"),
    );
    expect(rendered).not.toContain("every step established");
  });

  it("says every step was established where none is missing", () => {
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a"), flow("feat_Leave", "svc:GET /b")],
      features: [feature("Leave", 2)],
    });
    expect(rendered).toContain(FRAME_EN["prd-flow-whole"]!.replace("{0}", "2"));
    expect(rendered).not.toContain("could not be resolved");
  });

  it("says a capability has no entry point rather than no traceable chain", () => {
    // All 12 of WCP's flowless capabilities have no endpoint at all, so "an entry
    // point was found, but no call chain could be followed" was wrong for every
    // one of them — and this run had call-edge extraction switched off besides.
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a")],
      features: [feature("Leave", 1), feature("Vocabulary", 0)],
    });
    expect(rendered).toContain("no entry point was attributed");
    expect(rendered).not.toContain("no call chain");
  });

  it("separates a capability with an entry point but no flow from one with neither", () => {
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a")],
      features: [feature("Leave", 1), feature("Silent", 4), feature("Vocabulary", 0)],
    });
    expect(rendered).toContain("no entry point was attributed");
    expect(rendered).toContain("have an entry point but no flow traced");
  });

  it("names the endpoints no capability claimed", () => {
    // 65 of WCP's 539 endpoints belonged to no capability and appeared nowhere in
    // a document meant to be built from.
    const rendered = render("prd-features", {
      features: [feature("Leave", 1)],
      endpoints: [
        { method: "GET", path: "/leave/0", rootName: "svc", middleware: [], handlerName: null },
        { method: "POST", path: "/cronjobs", rootName: "svc", middleware: [], handlerName: null },
      ],
    });
    expect(rendered).toContain("/cronjobs");
    expect(rendered).toContain("1 of 2 endpoints belong to no capability");
  });

  it("marks an absent address with a dash, as every other absence is marked", () => {
    // A capability detected from vocabulary alone has no address, and the cell was
    // rendered empty where the rest of the document writes an em dash.
    const rendered = render("prd-features", {
      features: [feature("Vocabulary", 0)],
      endpoints: [],
    });
    // By position: the endpoint-count cell is a dash too, so a bare `contains`
    // passed while the addresses cell rendered blank.
    const cells = rendered
      .split("\n")
      .find((line) => line.includes("Vocabulary"))!
      .split("|")
      .map((part) => part.trim());
    expect(cells[4]).toBe("—");
  });

  it("says nothing about orphan endpoints where every one is claimed", () => {
    const rendered = render("prd-features", {
      features: [feature("Leave", 1)],
      endpoints: [
        { method: "GET", path: "/leave/0", rootName: "svc", middleware: [], handlerName: null },
      ],
    });
    expect(rendered).not.toContain("belong to no capability");
  });

  it("labels how a rule was stated through the frame", () => {
    const rendered = render("prd-validation", {
      guards: [{ ...guard("svc", "a.go", "ErrNope", "x"), messageKind: "error-code" }],
    });
    expect(rendered).toContain(FRAME_EN["message-kind-error-code"]);
    expect(rendered).not.toContain("error-code |");
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

    expect(written.some((path) => path.endsWith("sections/intro.md"))).toBe(true);
    const part = readFileSync(join(outDir, "sections", "intro.md"), "utf8");
    // Moved, not rebuilt: the body is exactly the one in the whole document.
    expect(result.markdown).toContain(part.split("\n")[2]!);
  });

  it("opens the index with the document's first section", () => {
    // It kept the limitations instead — sound about a reader who opens one
    // section in isolation, but it made "what this could not establish" the
    // first thing anyone read on the landing page.
    const outDir = prepared("split-first");
    writeAssembled(outDir, assemble(outDir), { split: true });

    const index = readFileSync(join(outDir, "index.md"), "utf8");
    expect(index).toContain("## Parts");
    expect(existsSync(join(outDir, "sections", "parts.md"))).toBe(false);
    // And the limitations are a page like any other, reachable from the index.
    expect(existsSync(join(outDir, "sections", "limitations.md"))).toBe(true);
    expect(index).toContain("sections/limitations.md");
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
    expect(existsSync(join(outDir, "html", "sections", "intro.html"))).toBe(true);
    // The Markdown tree stays exactly what assemble wrote.
    expect(existsSync(join(outDir, "sections", "intro.html"))).toBe(false);
  });

  it("points the document's own links at the format being rendered", () => {
    // `index.md` links to `sections/parts.md`, which is right for Markdown.
    // Left alone in a page, that link shows raw source instead of the page.
    const outDir = assembled("export-links");
    exportDocument(outDir, "html", "T");

    const index = readFileSync(join(outDir, "html", "index.html"), "utf8");
    expect(index).toContain('href="sections/intro.html"');
    expect(index).not.toContain('href="sections/intro.md"');
  });

  it("keeps a translated document's pages and its navigation in agreement", () => {
    // A split report names each page by looking its heading up in the
    // manifest. With the template's English heading stored there, a Chinese
    // report named every page after its Chinese heading while every link
    // pointed at the section id: no link in the document resolved, and the
    // sidebar was in English beside Chinese pages.
    const outDir = join(workDir, "out", "translated-split");
    prepare({ template: loadTemplate(templateDir), kb, outDir, language: "zh-CN" });
    writeFileSync(
      join(outDir, "tasks", "_frame", "answer.md"),
      JSON.stringify({ "heading:Parts": "组成部分", "heading:Intro": "简介", contents: "目录" }),
    );
    prepare({
      template: loadTemplate(templateDir),
      kb,
      outDir,
      language: "zh-CN",
      preserveAnswers: true,
    });
    writeFileSync(join(outDir, "tasks", "intro", "answer.md"), "正文。");
    writeAssembled(outDir, assemble(outDir), { split: true });
    exportDocument(outDir, "html", "T");

    const index = readFileSync(join(outDir, "html", "index.html"), "utf8");
    // The page says what language it is in, so a screen reader does not read
    // Chinese aloud in English.
    expect(index).toContain('<html lang="zh-CN">');
    // The sidebar is in the report's language...
    expect(index).toContain("组成部分");
    // ...and every link it offers resolves to a file that exists.
    for (const href of [...index.matchAll(/href="(sections\/[^"#]+)"/g)].map((m) => m[1]!)) {
      expect(existsSync(join(outDir, "html", href)), href).toBe(true);
    }
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

    const section = readFileSync(join(outDir, "html", "sections", "intro.html"), "utf8");
    // The current page is marked, and the index is one link away.
    expect(section).toContain('aria-current="page"');
    expect(section).toContain('href="../index.html"');
    // The first section stays in the index, so its entry points into that page
    // while every other section is a sibling file.
    expect(section).toContain('href="../index.html#parts"');
    expect(section).toContain('href="limitations.html"');
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
    // The stack is a table row per repository now, not a line of prose. Two
    // tables carry a row per repository, so this is the one naming libraries.
    const row = report
      .split("\n")
      .find((line) => line.startsWith("| svc |") && line.includes("gin-gonic"));
    expect(row, "the repository's stack row must be written").toBeDefined();
    expect(row).toContain("github.com/gin-gonic/gin v1.9.1");
    expect(row).not.toContain("v1.9.1✱");
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

describe("a diagram that would not draw", () => {
  it("refuses a label carrying a quote inside a quoted label", () => {
    // Found in a Chinese report: `包含"今天"？` ended the label early, and the
    // whole flow rendered as source text where the picture should be.
    const problems = undrawableDiagramLines(
      [
        "```mermaid",
        "flowchart TD",
        '  a{"日期包含"今天"？"}',
        '  b["fine label"]',
        "```",
      ].join("\n"),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("今天");
  });

  it("leaves an ordinary label alone, including punctuation and breaks", () => {
    expect(
      undrawableDiagramLines(
        [
          "```mermaid",
          "flowchart TD",
          '  s(["员工填报工时<br/>（我的 → 工时）"])',
          '  s -->|"是"| t["拒绝（WKL_Forbidden）"]',
          '  t --> u{"内容为空？<br/>或超过 60000 字符？"}',
          "```",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("says nothing about quotes outside a diagram", () => {
    expect(undrawableDiagramLines('A sentence with "quoted words" in it.')).toEqual([]);
  });
});
