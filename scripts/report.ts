/**
 * Generates a browsable HTML report for a workspace.
 *
 *   pnpm run report -- <path...> [--out dir] [--lang en|zh]
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateReport } from "../engine/report/generate.js";
import { supportedLanguages } from "../engine/report/strings.js";

function main(argv: readonly string[]): number {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const valueFlags = new Set(["--out", "--lang"]);
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

  if (paths.length === 0) {
    throw new Error(
      `Usage: report <path...> [--out dir] [--lang ${supportedLanguages().join("|")}]`,
    );
  }

  const result = generateReport({
    paths,
    outputDir: resolve(value("--out") ?? "./.analysis/report"),
    ...(value("--lang") ? { language: value("--lang")! } : {}),
  });

  console.log(`Report written for run ${result.runId}`);
  console.log(`  ${result.moduleCount} features, ${result.componentCount} components`);
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
