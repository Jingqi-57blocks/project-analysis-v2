/**
 * Writes every format from one published specification.
 *
 * Split from generation because it does not need the project: given a
 * `report.json` it can produce the whole bundle again. That is what lets a
 * restyle, a wording fix, or a new exporter run without re-analyzing anything.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { copyReportAssets } from "./assets.js";
import { renderHtmlReport } from "./html.js";
import { renderMarkdownReport } from "./markdown.js";
import { modelFromSpec } from "./spec.js";
import type { ReportSpec } from "./json.js";
import type { ReportModel } from "./model.js";

/**
 * Writes every human- and agent-facing format from one specification.
 *
 * Exported so a published report can be re-rendered later: the spec on disk is
 * all this needs.
 */
export type RenderFormat = "markdown" | "html";

/**
 * Which renderings to write.
 *
 * The specification and the Markdown bundle are the base a later export reads
 * from; HTML is one derived view among several to come. Generating the base
 * alone keeps that directory readable and makes the dependency obvious — an
 * exporter consumes json and md, and never the pages.
 */
export function writeRenderings(
  spec: ReportSpec,
  outputDir: string,
  formats: readonly RenderFormat[] = ["markdown", "html"],
): readonly string[] {
  mkdirSync(outputDir, { recursive: true });
  // The diagram renderer is only worth copying where pages will use it.
  const rendererCopied = formats.includes("html") ? copyReportAssets(outputDir) : true;

  const base = modelFromSpec(spec);
  // Said in the report rather than swallowed: without the renderer the
  // diagrams appear as their source text, and a reader should know why.
  const model: ReportModel = rendererCopied
    ? base
    : {
        ...base,
        coverageNotes: [
          ...base.coverageNotes,
          {
            subject: "diagrams",
            note: "the diagram renderer could not be copied into the report, so diagrams appear as their source text",
          },
        ],
      };
  const written: string[] = [];

  if (formats.includes("markdown")) {
    for (const page of renderMarkdownReport(model, spec.dataModel.entities)) {
      const path = join(outputDir, page.filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, page.markdown, "utf8");
      written.push(path);
    }
  }

  if (formats.includes("html")) {
    for (const page of renderHtmlReport(model)) {
      const path = join(outputDir, page.filename);
      writeFileSync(path, page.html, "utf8");
      written.push(path);
    }
  }

  return written;
}

