/**
 * Generates a browsable HTML report for a workspace.
 *
 *   pnpm run report -- <path...> [--out dir] [--lang en|zh]
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

import { generateReport } from "../engine/report/generate.js";
import { writeRenderings, type RenderFormat } from "../engine/report/render.js";
import { parseReportSpec } from "../engine/report/spec.js";
import { supportedLanguages } from "../engine/report/strings.js";

function main(argv: readonly string[]): number {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const valueFlags = new Set(["--out", "--lang", "--from", "--formats"]);
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (valueFlags.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("--")) continue;
    paths.push(token);
  }

  // The specification is the artifact; every format is rendered from it. So a
  // restyle, a wording fix, or a new exporter needs the file, not the project.
  // json and md are the base an export reads; html is a derived view. Asking
  // for the base alone keeps that directory to the artifacts that matter.
  const requested = value("--formats");
  const formats =
    requested === undefined
      ? undefined
      : (requested
          .split(",")
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name === "markdown" || name === "md" || name === "html")
          .map((name) => (name === "md" ? "markdown" : name)) as RenderFormat[]);

  const from = value("--from");
  if (from !== undefined) {
    const outputDir = resolve(value("--out") ?? "./.analysis/report");
    const spec = parseReportSpec(readFileSync(resolve(from), "utf8"));
    const files = writeRenderings(spec, outputDir, formats);

    console.log(`Re-rendered run ${spec.run.id} from ${from}`);
    for (const file of files.slice(0, 3)) console.log(`  ${file}`);
    console.log(`  ${files.length} files in ${outputDir}`);
    return 0;
  }

  if (paths.length === 0) {
    throw new Error(
      `Usage: report <path...> [--out dir] [--lang ${supportedLanguages().join("|")}]\n` +
        `       report --from <report.json> [--out dir] [--formats markdown,html]`,
    );
  }

  const result = generateReport({
    paths,
    outputDir: resolve(value("--out") ?? "./.analysis/report"),
    ...(value("--lang") ? { language: value("--lang")! } : {}),
    ...(formats ? { formats } : {}),
  });

  console.log(`Report written for run ${result.runId}`);
  console.log(
    `  ${result.featureCount} features, ${result.moduleCount} modules, ${result.componentCount} components`,
  );
  for (const file of result.files) console.log(`  ${file}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
