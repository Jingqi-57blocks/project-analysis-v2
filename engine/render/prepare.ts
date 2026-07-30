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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KnowledgeBase } from "../kb/query.js";
import { hasFragment, renderFragment, FragmentError } from "./fragments.js";
import { isEmptyResult, resolveSelector } from "./selectors.js";
import { readPrompt, type Section, type Template } from "./template.js";
import {
  applyGlossary,
  frameFor,
  heading as localizeHeading,
  needsTranslation,
  t,
  type Glossary,
} from "./strings.js";

/** The task that holds the frame's translation, kept out of the document. */
export const FRAME_TASK = "_frame";

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
  /**
   * Rebuild only this section, leaving every other answer where it is.
   *
   * A report with one bad section should cost one section to fix. Preparing
   * the whole document again clears every answer — necessary when the
   * knowledge base has moved on, wasteful when a single fragment was wrong.
   */
  readonly only?: string;
  /**
   * Keep answers already written, rather than clearing them.
   *
   * A full prepare clears answers, since a new knowledge base can make them
   * stale. Applying a frame translation is the exception: the knowledge base
   * has not moved, only the language it is read in, so the prose stands.
   */
  readonly preserveAnswers?: boolean;
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

  if (options.only !== undefined) {
    const known = template.sections.some((section) => section.id === options.only);
    if (!known) {
      throw new Error(
        `Template "${template.id}" has no section "${options.only}". ` +
          `It has: ${template.sections.map((section) => section.id).join(", ")}`,
      );
    }
    assertSameSnapshot(options.outDir, kb);
  }

  mkdirSync(options.outDir, { recursive: true });
  const tasksDir = join(options.outDir, "tasks");

  // The frame — headings, table columns, diagram labels — in the report's
  // language. English is the source; another language is a filled-in
  // translation task, loaded here so this run's code sections come out in it.
  const headings = template.sections
    .map((section) => section.heading)
    .filter((value): value is string => value !== null);
  const frame = withTranslation(frameFor(headings), tasksDir, options.language);

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

    if (section.heading !== null) lines.push(`## ${localizeHeading(frame, section.heading)}`, "");

    if (section.kind === "code") {
      if (!hasFragment(section.fragment)) throw new FragmentError(section.fragment);
      const body = renderFragment(section.fragment, { data: lookup, params, kb, frame });
      lines.push(body === "" ? t(frame, "nothing-to-show") : body, "");
      codeSections += 1;
      continue;
    }

    const dir = join(tasksDir, section.id);
    mkdirSync(dir, { recursive: true });

    // An answer written from an older slice would be published against a
    // newer one. Cleared for the sections being rebuilt, and only those —
    // rebuilding one section must not discard the rest. A frame-only re-render
    // (preserveAnswers) keeps them all: the slice has not changed.
    const clearing =
      options.only === section.id || (options.only === undefined && options.preserveAnswers !== true);
    if (clearing) {
      rmSync(join(dir, "answer.md"), { force: true });
    }

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

  // The frame's own translation is a task like any other, but it is not a
  // section: it produces the words the report is built from, not a part of it.
  // Emitted only when the language is not English, and only for a full prepare
  // — rebuilding one section must not disturb a translation already given.
  if (needsTranslation(options.language) && options.only === undefined) {
    const frameTask = emitFrameTask(tasksDir, frameFor(headings), options.language!);
    if (!existsSync(join(tasksDir, FRAME_TASK, "answer.md"))) tasks.unshift(frameTask);
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
        ...(options.language === undefined ? {} : { language: options.language }),
        frame,
        sections: template.sections.map((section) => ({
          id: section.id,
          kind: section.kind,
          // The heading as the document renders it, not as the template
          // declares it. Everything downstream matches a rendered heading
          // against this: a split document names its files by looking a
          // heading up here, and a sidebar labels itself from it. With the
          // English heading stored, a translated report split into pages named
          // every file after its Chinese heading while every link pointed at
          // the section id, so no link in it resolved — and its navigation was
          // in English.
          heading: section.heading === null ? null : localizeHeading(frame, section.heading),
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
 * The frame in the report's language, when a translation has been supplied.
 *
 * The English frame otherwise — including on the first pass, before the host
 * has answered the translation task, so a half-prepared directory still holds
 * a readable (English) report rather than a broken one.
 */
function withTranslation(base: Glossary, tasksDir: string, language: string | undefined): Glossary {
  if (!needsTranslation(language)) return base;
  const answerPath = join(tasksDir, FRAME_TASK, "answer.md");
  if (!existsSync(answerPath)) return base;
  return applyGlossary(base, parseGlossary(readFileSync(answerPath, "utf8")));
}

/** A translated frame from the host's answer, tolerant of a JSON code fence. */
function parseGlossary(answer: string): Glossary {
  const body = answer.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    // A malformed answer falls back to English rather than failing the export;
    // the frame is chrome, and a readable English frame beats no report.
    return {};
  }
}

/** Writes the translation task: the English frame, and how to translate it. */
function emitFrameTask(tasksDir: string, english: Glossary, language: string): PreparedTask {
  const dir = join(tasksDir, FRAME_TASK);
  mkdirSync(dir, { recursive: true });

  const promptPath = join(dir, "prompt.md");
  const dataPath = join(dir, "data.json");
  const prompt = [
    `# Translate the report's frame into ${language}`,
    "",
    "`data.json` beside this file is the report's fixed wording — its headings, table",
    "column names and diagram labels — as keys mapped to English text.",
    "",
    `Return one JSON object with the **same keys**, each value translated into ${language}.`,
    "",
    "- Keep every `{0}`, `{1}` placeholder exactly as it is: they are filled with the",
    "  project's own facts — numbers, names — which must not be translated or moved.",
    "- Keep Markdown intact: leading and trailing `_` mark italics; leave them in place.",
    "- Translate only the wording. Do not add keys, drop keys, or explain anything.",
    "- Write the answer as the JSON object alone.",
    "",
    "This is the frame the report is built from. The facts inside it are never here,",
    "so nothing you write can change what the report claims — only the language it is",
    "read in.",
  ].join("\n");

  writeFileSync(promptPath, `${prompt}\n`, "utf8");
  writeFileSync(dataPath, `${JSON.stringify(english, null, 2)}\n`, "utf8");
  writeFileSync(
    join(dir, "task.json"),
    `${JSON.stringify({ sectionId: FRAME_TASK, kind: "frame", language }, null, 2)}\n`,
    "utf8",
  );

  return { sectionId: FRAME_TASK, heading: null, promptPath, dataPath, optional: false };
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

/**
 * Refuses to rebuild a section against a different analysis.
 *
 * The other answers in the directory were written from one snapshot. A
 * section regenerated against another is a document whose parts describe two
 * different runs, and nothing in the file would say so. Preparing the whole
 * document again is the way to move to a newer run — that clears the answers,
 * which is the point.
 */
function assertSameSnapshot(outDir: string, kb: KnowledgeBase): void {
  const path = join(outDir, "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`No prepared document at ${outDir}. Prepare it once before rebuilding a section.`);
  }

  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    identity?: string;
    runId?: string | null;
  };
  if (manifest.identity !== undefined && manifest.identity !== kb.snapshot.identity) {
    throw new Error(
      `This document was prepared from run ${manifest.runId ?? "(unnamed)"}, and the knowledge base ` +
        `now holds ${kb.snapshot.runId ?? "(unnamed)"}. Rebuilding one section against a different ` +
        "analysis would leave the document describing two runs. Prepare it again to move to this one.",
    );
  }
}
