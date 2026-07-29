/**
 * Renders what code can and writes down what the host agent must answer.
 *
 * The output is a directory, not a document: the partial report with a marked
 * hole per LLM section, and one task folder per hole holding the prompt and
 * exactly the slice of the knowledge base that prompt may use. The host reads
 * each task, writes `answer.md` beside it, and `assemble` splices them in.
 *
 * The engine never calls a model. That is what lets this run under Claude
 * Code, Codex CLI or anything else with an agent in it.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KnowledgeBase } from "../kb/query.js";
import { hasFragment, renderFragment, FragmentError } from "./fragments.js";
import { isEmptyResult, resolveSelector } from "./selectors.js";
import { readPrompt, type Section, type Template } from "./template.js";

/** Marks where an answer goes, so assemble can splice without re-rendering. */
export function marker(sectionId: string, edge: "begin" | "end"): string {
  return `<!-- llm:${sectionId}:${edge} -->`;
}

export interface PrepareOptions {
  readonly template: Template;
  readonly kb: KnowledgeBase;
  readonly outDir: string;
  readonly params?: Readonly<Record<string, string>>;
  /** Appended to every prompt. The wording of a document is a prompt's job. */
  readonly language?: string;
}

export interface PreparedTask {
  readonly sectionId: string;
  readonly heading: string | null;
  readonly promptPath: string;
  readonly dataPath: string;
  readonly optional: boolean;
}

export interface PrepareResult {
  readonly outDir: string;
  readonly runId: string | null;
  readonly tasks: readonly PreparedTask[];
  readonly codeSections: number;
  readonly omitted: readonly string[];
}

interface Collected {
  /** Keyed as the template wrote it — this is what the task's data.json holds. */
  readonly slice: Record<string, unknown>;
  /**
   * The same values, also reachable by the selector's bare name.
   *
   * A section writes `module-flows:$module`; the fragment that renders flows
   * asks for `module-flows`. Keyed only as written, every parameterized
   * lookup missed and the section rendered "nothing to show" over data it
   * had been handed.
   */
  readonly lookup: Record<string, unknown>;
  /** Parameterized selectors that resolved to nothing at all. */
  readonly unresolved: readonly string[];
}

function collect(
  kb: KnowledgeBase,
  section: Section,
  params: Readonly<Record<string, string>>,
): Collected {
  const slice: Record<string, unknown> = {};
  const lookup: Record<string, unknown> = {};
  const unresolved: string[] = [];

  for (const selector of section.requires) {
    const value = resolveSelector(kb, selector, params);
    slice[selector] = value;
    lookup[selector] = value;

    const base = selector.split(":")[0]!;
    if (!(base in lookup)) lookup[base] = value;

    // Null from a `$param` selector means the thing named does not exist —
    // distinct from a list that is legitimately empty.
    if (value === null && selector.includes(":$")) unresolved.push(selector);
  }

  return { slice, lookup, unresolved };
}

export function prepare(options: PrepareOptions): PrepareResult {
  const { template, kb } = options;
  const params = options.params ?? {};

  for (const name of template.params) {
    if (params[name] === undefined) {
      throw new Error(
        `Template "${template.id}" needs --param ${name}=<value>. ` +
          "Rendering it without one would produce a document about nothing in particular.",
      );
    }
  }

  mkdirSync(options.outDir, { recursive: true });
  const tasksDir = join(options.outDir, "tasks");

  const lines: string[] = [`# ${title(template, params, kb)}`, ""];
  const tasks: PreparedTask[] = [];
  const omitted: string[] = [];
  let codeSections = 0;

  for (const section of template.sections) {
    const { slice, lookup, unresolved } = collect(kb, section, params);

    if (unresolved.length > 0) {
      // A document about something that is not there would read as a
      // confident description of an empty thing.
      throw new Error(
        `Nothing in this knowledge base matches ${unresolved
          .map((selector) => `${selector.split(":$")[1]!}=${params[selector.split(":$")[1]!]!}`)
          .join(", ")}. Check \`export\` for the ids this run holds.`,
      );
    }

    // Coverage says how to read an empty section, so it never keeps one alive
    // — but `coverage-notes` is content, and matching it by prefix dropped the
    // one section whose whole job is saying what could not be established.
    const content = Object.entries(slice)
      .filter(([selector]) => !selector.startsWith("coverage:"))
      .map(([, value]) => value);
    if (section.omitWhenEmpty === true && content.length > 0 && content.every(isEmptyResult)) {
      omitted.push(section.id);
      continue;
    }

    if (section.heading !== null) lines.push(`## ${section.heading}`, "");

    if (section.kind === "code") {
      if (!hasFragment(section.fragment)) throw new FragmentError(section.fragment);
      const body = renderFragment(section.fragment, { data: lookup, params, kb });
      lines.push(body === "" ? "_Nothing to show here._" : body, "");
      codeSections += 1;
      continue;
    }

    const dir = join(tasksDir, section.id);
    mkdirSync(dir, { recursive: true });

    // A prepare re-run against a changed knowledge base leaves an answer
    // written from the old slice, which assemble would publish as ✓.
    rmSync(join(dir, "answer.md"), { force: true });

    const promptPath = join(dir, "prompt.md");
    const dataPath = join(dir, "data.json");
    writeFileSync(promptPath, promptFor(template, section, options.language), "utf8");
    writeFileSync(dataPath, `${JSON.stringify(slice, null, 2)}\n`, "utf8");
    writeFileSync(
      join(dir, "task.json"),
      `${JSON.stringify(
        {
          sectionId: section.id,
          heading: section.heading,
          optional: section.optional === true,
          requires: section.requires,
          contract: section.contract ?? {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    lines.push(marker(section.id, "begin"), marker(section.id, "end"), "");
    tasks.push({
      sectionId: section.id,
      heading: section.heading,
      promptPath,
      dataPath,
      optional: section.optional === true,
    });
  }

  writeFileSync(join(options.outDir, "report.partial.md"), `${lines.join("\n").trimEnd()}\n`, "utf8");
  writeFileSync(
    join(options.outDir, "manifest.json"),
    `${JSON.stringify(
      {
        template: template.id,
        title: template.title,
        params,
        runId: kb.snapshot.runId,
        identity: kb.snapshot.identity,
        workspacePath: kb.snapshot.workspacePath,
        sections: template.sections.map((section) => ({
          id: section.id,
          kind: section.kind,
          heading: section.heading,
          optional: section.kind === "llm" && section.optional === true,
          omitted: omitted.includes(section.id),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    outDir: options.outDir,
    runId: kb.snapshot.runId,
    tasks,
    codeSections,
    omitted,
  };
}

function title(
  template: Template,
  params: Readonly<Record<string, string>>,
  kb: KnowledgeBase,
): string {
  // A param that names a record is shown by that record's name: an id in a
  // title tells a reader nothing.
  const named = (id: string): string =>
    kb.modules().find((module) => module.id === id)?.name ??
    kb.features().find((feature) => feature.id === id)?.name ??
    id;

  const known: Record<string, string | undefined> = {
    project: kb.runContext()?.projectName,
  };
  for (const [key, value] of Object.entries(params)) known[key] = named(value);

  return template.title.replaceAll(/\$(\w+)/g, (whole, name: string) => known[name] ?? whole);
}

/**
 * The prompt as the host agent sees it.
 *
 * The rules below are the engine's, not the template author's: an answer that
 * invents a fact, or writes a heading that outranks the document, breaks the
 * report regardless of what the section is about.
 */
function promptFor(template: Template, section: Section, language?: string): string {
  const body = readPrompt(template, section as never);
  const contract = section.kind === "llm" ? (section.contract ?? {}) : {};

  const rules = [
    "## How this answer is used",
    "",
    `Your reply becomes the section "${section.heading ?? section.id}" of a generated report.`,
    "Write the section body only — no preamble, no sign-off, no repetition of the heading.",
    "",
    "- `data.json` beside this file is everything you may state. Anything not in it is not established; say so rather than filling the gap.",
    "- Where the data records that something could not be established, say that plainly instead of writing around it.",
    "- Never invent a name, number, path or capability.",
  ];
  if (contract.maxWords !== undefined) rules.push(`- At most ${contract.maxWords} words.`);
  if (contract.maxHeadingLevel !== undefined) {
    rules.push(`- Headings no shallower than level ${contract.maxHeadingLevel} (\`${"#".repeat(contract.maxHeadingLevel)}\`).`);
  }
  if (contract.requiredHeadings !== undefined) {
    rules.push("- One heading per item you were given, named exactly as the data names it.");
  }
  if (language !== undefined) {
    rules.push(
      `- Write in ${language}. Identifiers, paths and table names stay exactly as the data spells them.`,
    );
  }

  return `${body.trimEnd()}\n\n${rules.join("\n")}\n`;
}
