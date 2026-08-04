/**
 * Whether this build and the installed CodeGraph still agree.
 *
 *   pnpm compat:codegraph
 *
 * The adapter reads CodeGraph's own index database, pinned to one version and
 * one schema. Nothing in CI exercised that: the workflow installed this
 * project's dependencies and ran unit tests, and every test that needs a real
 * index skips when there is no target on the machine. So the one boundary that
 * can break without any of our code changing was the one boundary never checked.
 *
 * This indexes a tiny two-language fixture and asserts what the adapter relies
 * on: an index gets built, the schema is the one the reader expects, nodes and
 * call edges come back, and the run refuses rather than degrades when the
 * schema is not the expected one. Then it runs a full analysis over the same
 * fixture and reads the published snapshot back through the report-side
 * commands.
 *
 * What it does not check is report quality — no model runs here. It checks the
 * plumbing an unattended report depends on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { codeIndexDbPath, readBatchDb, snapshotFromDb, SUPPORTED_DB_SCHEMA } from "../engine/providers/codegraph/batchdb.js";
import { VERIFIED_VERSION, codegraphVersion, ensureIndexed } from "../engine/providers/codegraph/cli.js";
import { resolveSnapshot } from "../engine/kb/query.js";
import { reportReadiness } from "../engine/report/readiness.js";
import { runAnalyze } from "../engine/run/analyze.js";
import { openStoreReadonly } from "../engine/store/open.js";

const FIXTURE = resolve("tests/fixtures/codegraph-compat");

const failures: string[] = [];
function check(what: string, holds: boolean, detail = ""): void {
  if (holds) {
    console.log(`  ok    ${what}`);
    return;
  }
  console.log(`  FAIL  ${what}${detail === "" ? "" : ` — ${detail}`}`);
  failures.push(what);
}

const installed = codegraphVersion();
console.log(`codegraph ${installed ?? "(not installed)"}, adapter verified against ${VERIFIED_VERSION}`);
if (installed === null) {
  console.error("codegraph is not on PATH; this check exists to run where it is.");
  process.exit(2);
}
check("the installed version is the pinned one", installed === VERIFIED_VERSION, `installed ${installed}`);

console.log("\nindexing the fixture");
ensureIndexed(FIXTURE);

const outcome = readBatchDb(codeIndexDbPath(FIXTURE), FIXTURE);
check("the index reads as verified", outcome.ok, outcome.ok ? "" : JSON.stringify(outcome.degradation));

if (outcome.ok) {
  const snapshot = outcome.snapshot;
  const paths = new Set(snapshot.nodes.map((node) => node.filePath));

  check("the schema is the one the reader was written against", snapshot.metadata.schemaVersion === String(SUPPORTED_DB_SCHEMA));
  check("both languages were indexed", [...paths].some((p) => p.endsWith(".go")) && [...paths].some((p) => p.endsWith(".ts")));
  check("symbols came back", snapshot.nodes.length > 0, `${snapshot.nodes.length} nodes`);
  check("call edges came back", snapshot.edges.some((edge) => edge.kind === "calls"), `${snapshot.edges.length} edges`);
  check(
    "edges other than calls came back",
    snapshot.edges.some((edge) => edge.kind !== "calls"),
    [...new Set(snapshot.edges.map((e) => e.kind))].join(", "),
  );
}

/**
 * The refusal, exercised rather than trusted.
 *
 * This is the branch that used to downgrade to a nodes-only read, and it is the
 * one nobody notices when it misbehaves — the run succeeds and the report is
 * merely wrong. A bumped schema number is enough to reach it.
 */
console.log("\nrefusing an index this build cannot read");
{
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE schema_versions (version INTEGER, applied_at INTEGER, description TEXT)");
  db.prepare("INSERT INTO schema_versions VALUES (?,?,?)").run(SUPPORTED_DB_SCHEMA + 1, 0, "from the future");
  const refused = snapshotFromDb(db, "/idx");
  db.close();

  check(
    "an unexpected schema fails closed rather than degrading",
    !refused.ok && refused.degradation.kind === "schema-unsupported",
  );
}

console.log("\nanalysing the fixture end to end");
const workDir = mkdtempSync(join(tmpdir(), "pa-compat-"));
try {
  const dbPath = join(workDir, "kb.sqlite");
  const result = runAnalyze({ paths: [join(FIXTURE, "service"), join(FIXTURE, "web")], dbPath });
  console.log(`  run ${result.runId} → snapshot ${result.snapshotId}`);

  const store = openStoreReadonly(dbPath);
  const snapshot = resolveSnapshot(store, result.runId);

  check("the snapshot published", snapshot.id === result.snapshotId);
  check(
    "codegraph is recorded as available",
    store.get<{ n: number }>(
      "select count(*) as n from provider_checks where snapshot_id = ? and provider_id = 'codegraph' and available = 1",
      [snapshot.id],
    )?.n === 1,
  );

  const edges =
    store.get<{ n: number }>(
      "select count(*) as n from structural_records where snapshot_id = ? and kind = 'call-edge'",
      [snapshot.id],
    )?.n ?? 0;
  check("call edges reached the knowledge base", edges > 0, `${edges} edges`);

  const readiness = reportReadiness(store, snapshot.id, "project-product");
  check("an overview could be written from it", readiness.ready);

  store.close();
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.error(`codegraph compatibility: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("codegraph compatibility: every check passed");
