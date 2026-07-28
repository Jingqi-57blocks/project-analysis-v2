/**
 * Reports what a knowledge base currently holds for a workspace.
 *
 *   pnpm run status -- [--workspace path] [--db path] [--run run-id]
 *
 * Defaults `--workspace` to the current directory and `--db` to
 * `./.analysis/kb.sqlite`, matching `scripts/analyze.ts`.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../engine/store/open.js";
import { getStatus } from "../engine/run/status.js";

const DEFAULT_DB_PATH = "./.analysis/kb.sqlite";

interface Args {
  readonly workspace: string;
  readonly dbPath: string;
  /** Reports a specific run rather than the latest, so reports can be tied together. */
  readonly runId: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    workspace: resolve(value("--workspace") ?? process.cwd()),
    dbPath: resolve(value("--db") ?? DEFAULT_DB_PATH),
    runId: value("--run"),
  };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const store = openStore(args.dbPath);

  try {
    const status = getStatus(store, args.workspace, args.runId);

    if (!status.analyzed) {
      console.log(
        args.runId
          ? `${args.workspace}: no published run ${args.runId}`
          : `${args.workspace}: never analyzed`,
      );
      return 0;
    }

    console.log(args.workspace);
    console.log(`  run ${status.runId ?? "(predates run ids)"}`);
    console.log(`  snapshot ${status.snapshotId} (${status.identity}), published ${status.publishedAt}`);
    for (const root of status.roots ?? []) {
      const counts = root.counts.map((c) => `${c.disposition}=${c.count}`).join(" ");
      const vcsInfo = root.vcs === "git" ? `git${root.dirty ? ", dirty" : ""}` : "no vcs";
      console.log(`  ${root.name} [${vcsInfo}]: ${counts}`);
    }
    for (const check of status.providerChecks ?? []) {
      console.log(`  provider ${check.providerId}: ${check.available ? "available" : `unavailable (${check.reason})`}`);
    }

    return 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
