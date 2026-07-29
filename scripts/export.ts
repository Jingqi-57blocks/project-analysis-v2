/**
 * Produces something from a knowledge base.
 *
 *   pnpm run export -- --as json                      [--out path]
 *   pnpm run export -- --as overview                  [--out dir] [--format html]
 *   pnpm run export -- --as capability --param capability=<id>
 *
 * One act: take a knowledge base, produce a thing. `--as` chooses what,
 * `--format` chooses how it is written down. Neither opens the project — a
 * knowledge base can be exported on a machine that does not have the source.
 *
 * A document with sections somebody has to write cannot finish in one call,
 * so `--as <document>` prepares the tasks on first run and assembles them once
 * they are answered. `--only <section>` rebuilds one section; `--force`
 * starts the document again from scratch.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../engine/store/open.js";
import { openKnowledgeBase, type KnowledgeBase } from "../engine/kb/query.js";
import { renderExport } from "../engine/kb/export.js";
import { assertOutsideRoots } from "../engine/run/analyze.js";
import { loadTemplate } from "../engine/render/template.js";
import { prepare } from "../engine/render/prepare.js";
import { assemble, writeAssembled } from "../engine/render/assemble.js";
import { exportDocument } from "../engine/render/export.js";

const DEFAULT_DB_PATH = "./.analysis/kb.sqlite";

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function params(argv: readonly string[]): Record<string, string> {
  const collected: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue;
    const pair = argv[i + 1] ?? "";
    const equals = pair.indexOf("=");
    if (equals === -1) throw new Error(`--param expects name=value, got "${pair}"`);
    collected[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return collected;
}

/** Nothing this command writes may land inside an analyzed root. */
function assertSafeOutput(kb: KnowledgeBase, outPath: string, store: ReturnType<typeof openStore>): void {
  assertOutsideRoots(
    outPath,
    store.all<{ name: string; path: string }>(
      "SELECT name, path FROM source_roots WHERE snapshot_id = ?",
      [kb.snapshot.id],
    ),
  );
}

function exportJson(kb: KnowledgeBase, argv: readonly string[], store: ReturnType<typeof openStore>): number {
  const outPath = resolve(
    flagValue(argv, "--out") ?? `./.analysis/export/${kb.snapshot.runId ?? kb.snapshot.id}.json`,
  );
  assertSafeOutput(kb, outPath, store);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderExport(kb), "utf8");

  console.log(`Exported run ${kb.snapshot.runId ?? "(unnamed)"} of ${kb.snapshot.workspacePath}`);
  console.log(`  ${kb.features().length} capabilities, ${kb.modules().length} modules`);
  console.log(`  ${outPath}`);
  return 0;
}

function exportDocumentType(
  kb: KnowledgeBase,
  as: string,
  argv: readonly string[],
  store: ReturnType<typeof openStore>,
): number {
  const template = loadTemplate(as);
  const given = params(argv);
  const suffix = template.params.map((name) => given[name]).join("-");
  const outDir = resolve(
    flagValue(argv, "--out") ??
      `./.analysis/export/${kb.snapshot.runId ?? kb.snapshot.id}/${template.id}${suffix === "" ? "" : `-${suffix}`}`,
  );
  assertSafeOutput(kb, outDir, store);

  const only = flagValue(argv, "--only");
  const language = flagValue(argv, "--lang");
  const prepared = existsSync(join(outDir, "manifest.json"));

  if (argv.includes("--force")) rmSync(outDir, { recursive: true, force: true });

  if (!prepared || argv.includes("--force") || only !== undefined) {
    const result = prepare({
      template,
      kb,
      outDir,
      params: given,
      ...(language === undefined ? {} : { language }),
      ...(only === undefined ? {} : { only }),
    });

    const waiting = result.tasks.filter(
      (task) => !existsSync(join(outDir, "tasks", task.sectionId, "answer.md")),
    );
    if (waiting.length > 0) {
      console.log(`Prepared ${template.id} for run ${result.runId ?? "(unnamed)"}`);
      console.log(`  ${result.codeSections} sections rendered from the knowledge base`);
      if (result.omitted.length > 0) {
        console.log(`  ${result.omitted.length} omitted as empty: ${result.omitted.join(", ")}`);
      }
      console.log(`  ${waiting.length} awaiting an answer:`);
      for (const task of waiting) {
        console.log(`    ${join(outDir, "tasks", task.sectionId)}/  → write answer.md`);
      }
      console.log(`  then run this command again to assemble`);
      return 0;
    }
  }

  const result = assemble(outDir, argv.includes("--allow-missing"));
  const written = writeAssembled(outDir, result, { split: !argv.includes("--no-split") });

  console.log(`Exported ${template.id} for run ${kb.snapshot.runId ?? "(unnamed)"}`);
  for (const outcome of result.outcomes) {
    const problems = outcome.problems.map((problem) => problem.detail).join("; ");
    console.log(`  ${outcome.filled ? "✓" : "·"} ${outcome.sectionId}${problems === "" ? "" : ` — ${problems}`}`);
  }
  console.log(`  ${written[0]!}`);

  const format = flagValue(argv, "--format");
  if (format !== undefined) {
    const view = exportDocument(outDir, format, template.title);
    console.log(`  ${view.files.length} ${view.format} file(s) in ${view.outDir}`);
  }
  return 0;
}

function main(input: readonly string[]): number {
  const argv = input[0] === "--" ? input.slice(1) : input;
  const as = flagValue(argv, "--as") ?? "json";
  const store = openStore(resolve(flagValue(argv, "--db") ?? DEFAULT_DB_PATH));

  try {
    const kb = openKnowledgeBase(store, flagValue(argv, "--run"), flagValue(argv, "--workspace"));
    return as === "json" ? exportJson(kb, argv, store) : exportDocumentType(kb, as, argv, store);
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
