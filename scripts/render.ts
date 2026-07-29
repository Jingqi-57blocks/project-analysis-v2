/**
 * Renders a template against a knowledge base, in two steps.
 *
 *   pnpm run render -- prepare <template> [--db path] [--run id] [--param k=v]
 *                                        [--lang zh] [--out dir]
 *   pnpm run render -- assemble <runDir> [--html] [--split] [--allow-missing]
 *
 * Between the two, a host agent answers each task: read `tasks/<id>/prompt.md`
 * and `data.json`, write `answer.md` beside them. Nothing else.
 */

import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { openStore } from "../engine/store/open.js";
import { openKnowledgeBase } from "../engine/kb/query.js";
import { loadTemplate } from "../engine/render/template.js";
import { prepare } from "../engine/render/prepare.js";
import { assemble, writeAssembled } from "../engine/render/assemble.js";
import { renderHtml } from "../engine/render/html.js";

const DEFAULT_DB_PATH = "./.analysis/kb.sqlite";

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  // Silently falling back would use a different knowledge base, or drop the
  // language, without saying so.
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
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

function runPrepare(argv: readonly string[]): number {
  const templateId = argv[0];
  if (templateId === undefined || templateId.startsWith("--")) {
    throw new Error("Usage: render prepare <template> [--db path] [--run id] [--param k=v] [--out dir]");
  }

  const store = openStore(resolve(flagValue(argv, "--db") ?? DEFAULT_DB_PATH));
  try {
    const kb = openKnowledgeBase(store, flagValue(argv, "--run"), flagValue(argv, "--workspace"));
    const template = loadTemplate(templateId);
    const given = params(argv);
    const suffix = template.params.map((name) => given[name]).join("-");
    const outDir = resolve(
      flagValue(argv, "--out") ??
        `./.analysis/render/${kb.snapshot.runId ?? kb.snapshot.id}/${template.id}${suffix === "" ? "" : `-${suffix}`}`,
    );

    const language = flagValue(argv, "--lang");
    const result = prepare({
      template,
      kb,
      outDir,
      params: given,
      ...(language === undefined ? {} : { language }),
    });

    console.log(`Prepared ${template.id} for run ${result.runId ?? "(unnamed)"}`);
    console.log(`  ${result.codeSections} sections rendered from the knowledge base`);
    if (result.omitted.length > 0) {
      console.log(`  ${result.omitted.length} omitted as empty: ${result.omitted.join(", ")}`);
    }
    console.log(`  ${result.tasks.length} awaiting an answer:`);
    for (const task of result.tasks) {
      console.log(`    tasks/${task.sectionId}/  → write answer.md${task.optional ? " (optional)" : ""}`);
    }
    console.log(`  ${outDir}`);
    return 0;
  } finally {
    store.close();
  }
}

function runAssemble(argv: readonly string[]): number {
  const runDir = argv[0];
  if (runDir === undefined || runDir.startsWith("--")) {
    throw new Error("Usage: render assemble <runDir> [--html] [--split] [--allow-missing]");
  }
  const dir = resolve(runDir);
  const result = assemble(dir, argv.includes("--allow-missing"));
  const written = writeAssembled(dir, result, { split: argv.includes("--split") });

  console.log(`Assembled ${written[0]!}`);
  for (const path of written.slice(1)) console.log(`  ${path}`);
  for (const outcome of result.outcomes) {
    const problems = outcome.problems.map((problem) => problem.detail).join("; ");
    console.log(`  ${outcome.filled ? "✓" : "·"} ${outcome.sectionId}${problems === "" ? "" : ` — ${problems}`}`);
  }

  if (argv.includes("--html")) {
    const manifestPath = resolve(dir, "manifest.json");
    const title = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { title?: string }).title ?? basename(dir)
      : basename(dir);

    // Rendered from the files just written, so the page and the Markdown
    // carry the same contents rather than two renderings of one document.
    for (const markdownPath of written.filter((path) => path.endsWith(".md"))) {
      const htmlPath = markdownPath.replace(/\.md$/, ".html");
      writeFileSync(
        htmlPath,
        renderHtml(readFileSync(markdownPath, "utf8"), title),
        "utf8",
      );
      console.log(`  ${htmlPath}`);
    }
  }
  return 0;
}

function main(input: readonly string[]): number {
  // `pnpm run render -- prepare ...` forwards the separator as an argument.
  // Read positionally, that separator was the command, so the documented
  // invocation always printed usage and exited 1.
  const argv = input[0] === "--" ? input.slice(1) : input;
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === "prepare") return runPrepare(rest);
  if (command === "assemble") return runAssemble(rest);
  throw new Error("Usage: render prepare <template> ... | render assemble <runDir> ...");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
