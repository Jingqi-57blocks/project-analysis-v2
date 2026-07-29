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
export function writeRenderings(spec: ReportSpec, outputDir: string): readonly string[] {
  mkdirSync(outputDir, { recursive: true });
  const rendererCopied = copyReportAssets(outputDir);

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

  for (const page of renderMarkdownReport(model, spec.dataModel.entities)) {
    const path = join(outputDir, page.filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page.markdown, "utf8");
    written.push(path);
  }

  for (const page of renderHtmlReport(model)) {
    const path = join(outputDir, page.filename);
    writeFileSync(path, page.html, "utf8");
    written.push(path);
  }

  return written;
}

