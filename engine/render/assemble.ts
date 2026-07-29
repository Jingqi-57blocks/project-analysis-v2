/**
 * Splices the answers into the prepared document.
 *
 * A pure file operation — it never opens the knowledge base. Everything it
 * needs was written at prepare time, which is what makes an answer replaceable
 * one section at a time without re-running the analysis.
 *
 * A missing or invalid answer refuses by default. `--allow-missing` splices an
 * explicit admission in its place instead; either way the gap is stated, never
 * quietly closed.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { marker } from "./prepare.js";
import { validateAnswer, type AnswerProblem } from "./validate.js";
import type { Contract } from "./template.js";

interface TaskFile {
  readonly sectionId: string;
  readonly heading: string | null;
  readonly optional: boolean;
  readonly contract: Contract;
}

export interface SectionOutcome {
  readonly sectionId: string;
  readonly filled: boolean;
  readonly problems: readonly AnswerProblem[];
}

export interface AssembleResult {
  readonly markdown: string;
  readonly outcomes: readonly SectionOutcome[];
  readonly refusals: readonly AnswerProblem[];
}

export class UnansweredSectionsError extends Error {
  constructor(readonly problems: readonly AnswerProblem[]) {
    super(
      `${problems.length} section(s) cannot be assembled:\n` +
        problems.map((problem) => `  ${problem.sectionId}: ${problem.detail}`).join("\n") +
        "\nAnswer them, or pass --allow-missing to publish the document with the gaps stated.",
    );
    this.name = "UnansweredSectionsError";
  }
}

interface Manifest {
  readonly title?: string;
  readonly sections?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly heading: string | null;
    readonly optional?: boolean;
    readonly omitted?: boolean;
  }[];
}

function readManifest(runDir: string): Manifest {
  const path = join(runDir, "manifest.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : {};
}

/**
 * The sections that owe an answer, from the manifest rather than from disk.
 *
 * Enumerating `tasks/` alone means a task directory that never got written —
 * or got written somewhere else — is simply not noticed: the marker stays in
 * the document, `assemble` exits 0, and an unwritten section is published as
 * an empty one.
 */
function readTasks(runDir: string, manifest: Manifest): readonly TaskFile[] {
  const tasksDir = join(runDir, "tasks");
  const declared = (manifest.sections ?? []).filter(
    (section) => section.kind === "llm" && section.omitted !== true,
  );

  if (declared.length > 0) {
    return declared.map((section) => {
      const path = join(tasksDir, section.id, "task.json");
      return existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as TaskFile)
        : {
            sectionId: section.id,
            heading: section.heading,
            optional: section.optional === true,
            contract: {},
          };
    });
  }

  // No manifest — an older run directory, or one assembled by hand.
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(tasksDir, entry.name, "task.json")))
    .map((entry) => JSON.parse(readFileSync(join(tasksDir, entry.name, "task.json"), "utf8")) as TaskFile)
    .sort((a, b) => a.sectionId.localeCompare(b.sectionId));
}

export function assemble(runDir: string, allowMissing = false): AssembleResult {
  const partialPath = join(runDir, "report.partial.md");
  if (!existsSync(partialPath)) {
    throw new Error(`No prepared document at ${partialPath}. Run \`render prepare\` first.`);
  }

  let markdown = readFileSync(partialPath, "utf8");
  const outcomes: SectionOutcome[] = [];
  const refusals: AnswerProblem[] = [];

  for (const task of readTasks(runDir, readManifest(runDir))) {
    const dir = join(runDir, "tasks", task.sectionId);
    const answerPath = join(dir, "answer.md");
    const dataPath = join(dir, "data.json");
    const problems: AnswerProblem[] = [];
    let body: string;
    let written = false;

    if (!existsSync(answerPath)) {
      problems.push({
        sectionId: task.sectionId,
        severity: task.optional ? "warning" : "refusal",
        detail: "no answer.md was written",
      });
      body = admission(task, false);
    } else {
      written = true;
      const answer = readFileSync(answerPath, "utf8");
      const data = existsSync(dataPath)
        ? (JSON.parse(readFileSync(dataPath, "utf8")) as unknown)
        : {};
      problems.push(...validateAnswer(task.sectionId, answer, task.contract, data));
      const failed = problems.some((problem) => problem.severity === "refusal");
      body = failed ? admission(task, true) : answer.trim();
    }

    const spliced = splice(markdown, task.sectionId, body);
    if (spliced === markdown && written) {
      // The document has no hole for this answer: the prepared file and the
      // task directory disagree about what the document contains.
      problems.push({
        sectionId: task.sectionId,
        severity: "refusal",
        detail: "the prepared document has no marker for this section, so the answer has nowhere to go",
      });
    }
    markdown = spliced;

    refusals.push(...problems.filter((problem) => problem.severity === "refusal"));
    outcomes.push({
      sectionId: task.sectionId,
      filled: !problems.some((problem) => problem.severity === "refusal"),
      problems,
    });
  }

  outcomes.sort((a, b) => a.sectionId.localeCompare(b.sectionId));

  if (refusals.length > 0 && !allowMissing) throw new UnansweredSectionsError(refusals);

  return { markdown, outcomes, refusals };
}

function admission(task: TaskFile, written: boolean): string {
  const what = task.heading ?? task.sectionId;
  return written
    ? `_This section was written but refused: the answer did not meet its contract. It would have described: ${what}._`
    : `_This section was not written. It would have described: ${what}._`;
}

function splice(markdown: string, sectionId: string, body: string): string {
  const begin = marker(sectionId, "begin");
  const end = marker(sectionId, "end");
  const start = markdown.indexOf(begin);
  const stop = markdown.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return markdown;
  return `${markdown.slice(0, start + begin.length)}\n${body}\n${markdown.slice(stop)}`;
}

export function writeAssembled(runDir: string, result: AssembleResult): string {
  const path = join(runDir, "report.md");
  writeFileSync(path, `${result.markdown.trimEnd()}\n`, "utf8");
  writeFileSync(
    join(runDir, "assembled.json"),
    `${JSON.stringify({ outcomes: result.outcomes }, null, 2)}\n`,
    "utf8",
  );
  return path;
}
