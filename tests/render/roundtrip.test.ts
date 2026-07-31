/**
 * Preparing, assembling, and the formats a document is viewed in.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadTemplate, parseTemplate } from "../../engine/render/template.js";
import { prepare } from "../../engine/render/prepare.js";
import { assemble, writeAssembled, UnansweredSectionsError } from "../../engine/render/assemble.js";
import { resolveSelector, SelectorError } from "../../engine/render/selectors.js";
import { hasFragment, renderFragment } from "../../engine/render/fragments.js";
import { FRAME_EN } from "../../engine/render/strings.js";
import { kb, prepareInto, reopen, store, templateDir, workDir } from "./fixture.js";

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
      language: "zh-CN" });
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
        sections: [{ id: "x", kind: "code", fragment: "limitations", requires: ["invented"] }] }),
    ).toThrow(SelectorError);
  });

  it("refuses a template that needs a parameter it was not given", () => {
    expect(() =>
      prepareInto("no-param", {
        params: ["capability"],
        sections: [
          { id: "x", kind: "code", fragment: "capability-data", requires: ["feature-detail:$capability"] },
        ] }),
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
      reopen();
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
          ] }),
        templateDir,
      ),
      kb,
      outDir,
      params: { capability: features[0]!.id } });

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
            ] }),
          templateDir,
        ),
        kb,
        outDir: join(workDir, "out", "ghost-module"),
        params: { capability: "feat_does_not_exist" } }),
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
              omitWhenEmpty: true },
          ] }),
        templateDir,
      ),
      kb,
      outDir });
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
      reason: `"/Screen${n}" mirrors a component's file path rather than an address` }));
    const rendered = renderFragment("limitations", {
      kb,
      params: {},
      data: { "coverage-notes": [], "extraction-failures": failures } });
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
      data: { "silent-files": files, "unread-files": unread } });
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
      data: { "silent-files": [silentFile("api", 1)], "unread-files": [silentFile("api", 2)] } });

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
