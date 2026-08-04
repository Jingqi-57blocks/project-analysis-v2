/**
 * Does the code index alone describe a project as well as the split does?
 *
 *   pnpm parity:symbols <path...> [--index-root dir]
 *
 * Today symbols and imports are partitioned: CodeGraph is told to skip every
 * file the local AST can parse, and the declaration reader supplies those. On a
 * Go/TypeScript project that means the local reader supplies *all* of them and
 * CodeGraph none — the arrangement is a split in name and single-sourced in
 * fact, just sourced from the other side.
 *
 * The partition exists for a measured reason: two readers describing one
 * function under different identities is not agreement. Both records survive,
 * the linking stage sees two symbols of one name, and handler resolution fell
 * from 438 to 38. Removing the declaration reader removes the same ambiguity
 * from the other end, and is worth doing only if nothing is lost by it.
 *
 * So: two runs over one project, same everything else, and a comparison of what
 * the knowledge base ends up holding. The thresholds below were fixed before any
 * run — deciding what counts as parity after seeing the numbers is how a
 * regression gets argued into being acceptable.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveSnapshot } from "../engine/kb/resolve-snapshot.js";
import { reportReadiness } from "../engine/report/readiness.js";
import { runAnalyze } from "../engine/run/analyze.js";
import { openStoreReadonly } from "../engine/store/open.js";
import type { Store } from "../engine/store/types.js";

/* ------------------------------------------------------------------ metrics */

interface Metrics {
  readonly symbols: number;
  readonly imports: number;
  readonly callEdges: number;
  readonly routes: number;
  readonly references: number;
  readonly conflicts: number;
  readonly traces: number;
  readonly features: number;
  readonly modules: number;
  readonly featureFlows: number;
  readonly behaviorFacts: number;
  /** Routes that named a handler and resolved to a unique symbol. */
  readonly handlersResolved: number;
  readonly handlersNamed: number;
  /** Share of identified entries the call graph could follow beyond themselves. */
  readonly entryTraceRate: number;
  readonly readyForFeatureReport: boolean;
}

const structural = (store: Store, snapshotId: number, kind: string): number =>
  store.get<{ n: number }>("select count(*) as n from structural_records where snapshot_id = ? and kind = ?", [
    snapshotId,
    kind,
  ])?.n ?? 0;

const derived = (store: Store, snapshotId: number, kind: string): number =>
  store.get<{ n: number }>("select count(*) as n from derived_records where snapshot_id = ? and kind = ?", [
    snapshotId,
    kind,
  ])?.n ?? 0;

function coverageNote(store: Store, snapshotId: number, subject: string): string | null {
  const rows = store.all<{ payload: string }>(
    "select payload from derived_records where snapshot_id = ? and kind = 'coverage-note'",
    [snapshotId],
  );
  for (const row of rows) {
    const parsed = JSON.parse(row.payload) as { subject?: string; note?: string };
    if (parsed.subject === subject) return parsed.note ?? null;
  }
  return null;
}

/**
 * Handler resolution, read from the note the derivation already writes.
 *
 * The note states the failures — "N of M routes naming a handler could not be
 * resolved" — and is absent entirely when there were none. Absence therefore
 * means every named handler resolved, not that none did, which is why this
 * needs the named total from the same sentence rather than a count of its own.
 */
function handlers(store: Store, snapshotId: number): { resolved: number; named: number } {
  const note = coverageNote(store, snapshotId, "route-handlers");
  if (note === null) {
    const named = store.get<{ n: number }>(
      `select count(*) as n from structural_records
        where snapshot_id = ? and kind = 'route' and json_array_length(payload, '$.handlerCandidates') > 0`,
      [snapshotId],
    )?.n ?? 0;
    return { resolved: named, named };
  }
  const match = /(\d+) of (\d+)/.exec(note);
  if (match === null) return { resolved: 0, named: 0 };
  const unresolved = Number(match[1]);
  const named = Number(match[2]);
  return { resolved: named - unresolved, named };
}

function entryTraceRate(store: Store, snapshotId: number): number {
  const note = coverageNote(store, snapshotId, "entry-traceability");
  const match = note === null ? null : /(\d+) of (\d+)/.exec(note);
  if (match === null) return 0;
  const total = Number(match[2]);
  return total === 0 ? 0 : Number(match[1]) / total;
}

function measure(dbPath: string, runId: string): Metrics {
  const store = openStoreReadonly(dbPath);
  try {
    const id = resolveSnapshot(store, runId).id;
    const h = handlers(store, id);
    return {
      symbols: structural(store, id, "symbol"),
      imports: structural(store, id, "import"),
      callEdges: structural(store, id, "call-edge"),
      routes: structural(store, id, "route"),
      references: structural(store, id, "reference"),
      conflicts:
        store.get<{ n: number }>(
          `select count(*) as n from structural_conflicts c
             join structural_records r on r.id = c.record_id where r.snapshot_id = ?`,
          [id],
        )?.n ?? 0,
      traces: derived(store, id, "trace"),
      features: derived(store, id, "feature"),
      modules: derived(store, id, "module"),
      featureFlows: derived(store, id, "feature-flow"),
      behaviorFacts: store.get<{ n: number }>("select count(*) as n from behavior_facts where snapshot_id = ?", [id])?.n ?? 0,
      handlersResolved: h.resolved,
      handlersNamed: h.named,
      entryTraceRate: entryTraceRate(store, id),
      readyForFeatureReport: reportReadiness(store, id, "feature-product").ready,
    };
  } finally {
    store.close();
  }
}

/* --------------------------------------------------------------- the verdict */

type Rule =
  | { readonly kind: "atLeastShare"; readonly of: keyof Metrics; readonly share: number }
  | { readonly kind: "atLeastCount"; readonly of: keyof Metrics }
  | { readonly kind: "withinShare"; readonly of: keyof Metrics; readonly tolerance: number }
  | { readonly kind: "atMostCount"; readonly of: keyof Metrics }
  | { readonly kind: "rateDrop"; readonly of: keyof Metrics; readonly points: number }
  | { readonly kind: "notWorse"; readonly of: keyof Metrics };

/**
 * What counts as parity. Fixed before the first run.
 *
 * The split is by what each number means. Coverage numbers — symbols, imports,
 * traces, behaviour facts — may move a little, because two readers will never
 * itemize a codebase identically and a few percent either way changes nothing a
 * reader would notice. Meaning numbers may not: handler resolution and entry
 * traceability are how a capability's flow is followed, and features and modules
 * are the report's own chapters. A run that keeps every symbol and loses the
 * handlers has lost the thing symbols were for.
 *
 * Call edges and references are held at 100% because CodeGraph already owns
 * them outright; unrestricting it cannot legitimately produce fewer.
 */
const RULES: readonly (Rule & { readonly why: string })[] = [
  { kind: "atLeastShare", of: "symbols", share: 0.9, why: "symbol coverage may not collapse" },
  { kind: "atLeastShare", of: "imports", share: 0.9, why: "import coverage may not collapse" },
  { kind: "atLeastCount", of: "callEdges", why: "CodeGraph already owns these; it cannot find fewer unrestricted" },
  { kind: "atLeastCount", of: "references", why: "same" },
  { kind: "atLeastCount", of: "handlersResolved", why: "the measurement that broke last time: 438 became 38" },
  { kind: "rateDrop", of: "entryTraceRate", points: 0.02, why: "flows must still be followable beyond the entry" },
  { kind: "atLeastShare", of: "traces", share: 0.95, why: "a trace is a capability's path through the system" },
  { kind: "withinShare", of: "features", tolerance: 0.1, why: "features are the report's chapters; boundaries must hold" },
  { kind: "withinShare", of: "modules", tolerance: 0.1, why: "same" },
  { kind: "atLeastShare", of: "behaviorFacts", share: 0.95, why: "rules, guards and states are what the report states" },
  { kind: "atMostCount", of: "conflicts", why: "one reader must not produce more ambiguity than two" },
  {
    kind: "notWorse",
    of: "readyForFeatureReport",
    why: "a capability report writable before must still be writable",
  },
];

interface Judgement {
  readonly metric: string;
  readonly before: number | boolean;
  readonly after: number | boolean;
  readonly bound: string;
  readonly passed: boolean;
  readonly why: string;
}

function judge(before: Metrics, after: Metrics): readonly Judgement[] {
  return RULES.map((rule) => {
    const a = before[rule.of];
    const b = after[rule.of];
    const base = { metric: rule.of, before: a, after: b, why: rule.why };

    // Parity, not absolute capability. A project the split lane could not write
    // a capability report from is not one this change broke — asserting `true`
    // outright would have made the harness grade the project instead of the
    // change, which it did on the first fixture it was pointed at.
    if (rule.kind === "notWorse") {
      return { ...base, bound: `not worse than ${String(a)}`, passed: a !== true || b === true };
    }
    const numA = Number(a);
    const numB = Number(b);
    switch (rule.kind) {
      case "atLeastShare":
        return {
          ...base,
          bound: `>= ${Math.round(rule.share * 100)}% of ${numA} (${Math.ceil(numA * rule.share)})`,
          passed: numA === 0 ? true : numB >= numA * rule.share,
        };
      case "atLeastCount":
        return { ...base, bound: `>= ${numA}`, passed: numB >= numA };
      case "atMostCount":
        return { ...base, bound: `<= ${numA}`, passed: numB <= numA };
      case "withinShare":
        return {
          ...base,
          bound: `${numA} ±${Math.round(rule.tolerance * 100)}%`,
          passed: numA === 0 ? numB === 0 : Math.abs(numB - numA) <= numA * rule.tolerance,
        };
      case "rateDrop":
        return {
          ...base,
          bound: `>= ${(numA - rule.points).toFixed(3)}`,
          passed: numB >= numA - rule.points,
        };
    }
  });
}

/* ------------------------------------------------------------------- running */

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const paths: string[] = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] ?? "";
  if (arg === "--") continue;
  if (arg.startsWith("--")) {
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      flags.set(arg.slice(2), value);
      i += 1;
    } else flags.set(arg.slice(2), "");
    continue;
  }
  paths.push(resolve(arg));
}

if (paths.length === 0) {
  console.error("usage: pnpm parity:symbols <path...> [--index-root dir]");
  process.exit(2);
}

const indexRoot = flags.get("index-root");
const workDir = mkdtempSync(join(tmpdir(), "pa-parity-"));

function lane(label: string, codegraphSymbolsOnly: boolean): Metrics {
  const dbPath = join(workDir, `${label}.sqlite`);
  const started = Date.now();
  const result = runAnalyze({
    paths,
    dbPath,
    ...(indexRoot === undefined ? {} : { indexRoot: resolve(indexRoot) }),
    ...(codegraphSymbolsOnly ? { codegraphSymbolsOnly: true } : {}),
  });
  console.log(`  ${label}: run ${result.runId} in ${Math.round((Date.now() - started) / 1000)}s`);
  return measure(dbPath, result.runId);
}

try {
  console.log(`parity over ${paths.join(", ")}\n`);
  console.log("running both lanes");
  const before = lane("split", false);
  const after = lane("codegraph-only", true);

  const judgements = judge(before, after);
  const width = Math.max(...judgements.map((j) => j.metric.length));

  console.log(`\n${"metric".padEnd(width)}  ${"split".padStart(10)}  ${"cg-only".padStart(10)}  bound`);
  console.log("-".repeat(width + 26 + 20));
  for (const j of judgements) {
    const fmt = (v: number | boolean): string =>
      typeof v === "boolean" ? String(v) : Number.isInteger(v) ? String(v) : v.toFixed(3);
    console.log(
      `${j.metric.padEnd(width)}  ${fmt(j.before).padStart(10)}  ${fmt(j.after).padStart(10)}  ${j.passed ? "ok  " : "FAIL"} ${j.bound}`,
    );
  }

  const failed = judgements.filter((j) => !j.passed);
  console.log("");
  if (failed.length === 0) {
    console.log("parity holds on every fixed threshold.");
  } else {
    console.log(`parity does not hold — ${failed.length} threshold(s) missed:`);
    for (const j of failed) console.log(`  ${j.metric}: ${j.why}`);
  }

  // Recorded, not judged: useful for reading the result, not for deciding it.
  console.log(`\nfor context — routes ${before.routes} → ${after.routes}, ` +
    `feature-flows ${before.featureFlows} → ${after.featureFlows}, ` +
    `handlers named ${before.handlersNamed} → ${after.handlersNamed}`);

  if (failed.length > 0) process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
