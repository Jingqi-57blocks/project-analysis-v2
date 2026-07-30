/**
 * Runs one full analysis over a workspace and persists it to a knowledge base.
 *
 *   pnpm run analyze -- <path...> [--include a,b] [--exclude c,d] [--db path]
 *                                [--no-code-index]
 *
 * The knowledge base defaults to `./.analysis/kb.sqlite`, gitignored — never
 * point `--db` inside an analyzed target; targets stay read-only.
 *
 * The project's own files are never changed. The code indexer does create a
 * `.codegraph/` directory of its own, in the folder holding the analyzed roots
 * and never inside one — reported when the run finishes and recorded in the
 * knowledge base, so every report states it too. Where it goes is not
 * configurable: the indexer stores its database inside whatever it indexes, so
 * only a directory containing the code can hold an index of it.
 * `--no-code-index` skips it and declares the missing symbols as a gap.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAnalyze } from "../engine/run/analyze.js";

const DEFAULT_DB_PATH = "./.analysis/kb.sqlite";

interface Args {
  readonly paths: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly noCodeIndex?: boolean;
  readonly dbPath: string;
}

const USAGE =
  "Usage: analyze <path...> [--include a,b] [--exclude c,d] [--db path] [--no-code-index]";

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
  const bareFlags = new Set(["--no-code-index"]);
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (valueFlags.has(token)) {
      i++;
      continue;
    }
    // `pnpm run analyze -- …` forwards the separator itself.
    if (token === "--") continue;
    if (bareFlags.has(token)) continue;
    // An unrecognised flag is refused rather than ignored, because ignoring one
    // does not stop at the flag: its value is not skipped either, so the next
    // token becomes a path and a directory nobody named gets analyzed. Removing
    // `--index-root` made that concrete — `--index-root /tmp/x` analyzed
    // `/tmp/x`, silently, and reported two roots where the user asked for one.
    if (token.startsWith("--")) {
      throw new Error(
        `Unknown option ${token}. ${USAGE}` +
          (token === "--index-root"
            ? "\n\n--index-root has been removed. The code index is built in the directory " +
              "holding the analyzed roots, which is the only place it can go: the indexer " +
              "stores its database inside whatever it indexes. Use --no-code-index to skip it."
            : ""),
      );
    }
    paths.push(token);
  }

  if (paths.length === 0) throw new Error(USAGE);

  const include = splitList("--include");
  const exclude = splitList("--exclude");


  return {
    paths,
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(argv.includes("--no-code-index") ? { noCodeIndex: true } : {}),
    dbPath: resolve(value("--db") ?? DEFAULT_DB_PATH),
  };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const result = runAnalyze({
    paths: args.paths,
    ...(args.include ? { include: args.include } : {}),
    ...(args.exclude ? { exclude: args.exclude } : {}),
    ...(args.noCodeIndex ? { noCodeIndex: true } : {}),
    dbPath: args.dbPath,
  });

  console.log(`Analyzed ${result.workspacePath}`);
  console.log(`  run ${result.runId}`);
  console.log(`  snapshot ${result.snapshotId} (${result.identity})`);
  for (const root of result.roots) {
    const c = root.counts;
    console.log(
      `  ${root.name}: analyzed=${c.analyzed} excluded=${c.excluded} unsupported=${c.unsupported} failed=${c.failed}`,
    );
  }
  console.log(`  providers checked: ${result.providerReport.results.length}`);
  console.log(`  knowledge base: ${args.dbPath}`);
  console.log(
    result.codeIndexPath === null
      ? "  code index: none written"
      : result.codeIndexPresent
        ? `  code index: ${result.codeIndexPath}/.codegraph — the only thing written near the source`
        : `  code index: none at ${result.codeIndexPath}/.codegraph — the indexer did not produce one; nothing was written near the source`,
  );

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
