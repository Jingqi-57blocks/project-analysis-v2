/**
 * Whether a snapshot holds enough for a given report type.
 *
 *   pnpm kb:readiness --spec feature-product [--run <runId>] [--db <kb.sqlite>]
 *
 * Run before writing, so that "this base cannot answer this" is discovered
 * while it is still cheap, rather than after a complete-looking report has been
 * written from a base with no call graph in it.
 *
 * Exits non-zero when the snapshot is not ready.
 */

import { resolve } from "node:path";

import { resolveSnapshot } from "../engine/kb/query.js";
import { explainReadiness, reportReadiness } from "../engine/report/readiness.js";
import { openStoreReadonly } from "../engine/store/open.js";
import { reportRefusals } from "./refusals.js";

reportRefusals();

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? "";
  if (arg === "--" || !arg.startsWith("--")) continue;
  const value = argv[index + 1];
  if (value !== undefined && !value.startsWith("--")) {
    flags.set(arg.slice(2), value);
    index += 1;
  } else {
    flags.set(arg.slice(2), "");
  }
}

const specId = flags.get("spec");
if (specId === undefined || specId === "") {
  console.error("usage: pnpm kb:readiness --spec <specId> [--run <runId>] [--db <kb.sqlite>]");
  process.exit(2);
}

const store = openStoreReadonly(resolve(flags.get("db") || ".analysis/kb.sqlite"));
const snapshot = resolveSnapshot(store, flags.get("run") || undefined, flags.get("workspace") || undefined);
const readiness = reportReadiness(store, snapshot.id, specId);

console.log(explainReadiness(readiness));
store.close();
if (!readiness.ready) process.exit(1);
