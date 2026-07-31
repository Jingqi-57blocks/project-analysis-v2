/**
 * A format is a view of one document, and rebuilding one section of it.
 */

import { kb, prepareInto, templateDir } from "./fixture.js";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadTemplate, parseTemplate } from "../../engine/render/template.js";
import { prepare } from "../../engine/render/prepare.js";
import { assemble, writeAssembled } from "../../engine/render/assemble.js";
import { exportDocument, retarget, UnknownFormatError } from "../../engine/render/export.js";
import { undrawableDiagramLines } from "../../engine/render/validate.js";
import { workDir } from "./fixture.js";

/**
 * The recovered-specification fragments, checked for keys that do not exist.
 *
 * A key with no string renders as `[key]` — the fallback is deliberate, so a
 * missing word degrades rather than throws, which means nothing fails until a
 * reader sees a bracket in a document. `[col-endpoints]` reached a rendered PRD
 * exactly that way.
 */
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
      preserveAnswers: true });
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
        ] }),
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
        only: "intro" }),
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
              omitWhenEmpty: true },
            {
              id: "dimensions",
              kind: "code",
              heading: "What Was Looked For",
              fragment: "analysis-dimensions",
              requires: ["analysis-dimensions"],
              omitWhenEmpty: true },
            {
              id: "flows",
              kind: "code",
              heading: "Business Flow Coverage",
              fragment: "flow-coverage",
              requires: ["flow-coverage"],
              omitWhenEmpty: true },
          ] }),
        templateDir,
      ),
      kb,
      outDir });
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
              requires: ["repositories"] },
          ] }),
        templateDir,
      ),
      kb,
      outDir,
      language: "zh-CN" });

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
