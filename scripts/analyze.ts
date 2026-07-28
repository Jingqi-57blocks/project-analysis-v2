/**
 * Runs one full analysis over a workspace and persists it to a knowledge base.
 *
 *   pnpm run analyze -- <path...> [--include a,b] [--exclude c,d] [--db path]
 *
 * The knowledge base defaults to `./.analysis/kb.sqlite`, gitignored — never
 * point `--db` inside an analyzed target; targets stay read-only.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAnalyze } from "../engine/run/analyze.js";

const DEFAULT_DB_PATH = "./.analysis/kb.sqlite";

interface Args {
  readonly paths: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly dbPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const splitList = (flag: string): string[] | undefined =>
    value(flag)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const valueFlags = new Set(["--db", "--include", "--exclude"]);
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
    throw new Error("Usage: analyze <path...> [--include a,b] [--exclude c,d] [--db path]");
  }

  const include = splitList("--include");
  const exclude = splitList("--exclude");

  return {
    paths,
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    dbPath: resolve(value("--db") ?? DEFAULT_DB_PATH),
  };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const result = runAnalyze({
    paths: args.paths,
    ...(args.include ? { include: args.include } : {}),
    ...(args.exclude ? { exclude: args.exclude } : {}),
    dbPath: args.dbPath,
  });

  console.log(`Analyzed ${result.workspacePath}`);
  console.log(`  snapshot ${result.snapshotId} (${result.identity})`);
  for (const root of result.roots) {
    const c = root.counts;
    console.log(
      `  ${root.name}: analyzed=${c.analyzed} excluded=${c.excluded} unsupported=${c.unsupported} failed=${c.failed}`,
    );
  }
  console.log(`  providers checked: ${result.providerReport.results.length}`);
  console.log(`  knowledge base: ${args.dbPath}`);

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
